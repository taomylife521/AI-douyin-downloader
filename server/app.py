"""FastAPI REST 服务入口。

HTTP 层薄封装：
- 接收 URL，创建 job，返回 job_id
- 实际下载委托给 cli.main.download_url 的简化复用
- SSE 输出 job 进度事件，供桌面 UI 实时消费

fastapi/uvicorn 是**可选**依赖。若未安装，导入本模块会 ImportError。
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel
from sse_starlette.sse import EventSourceResponse

from auth import CookieManager
from config import ConfigLoader
from control import QueueManager, RateLimiter, RetryHandler
from core import DouyinAPIClient, URLParser, DownloaderFactory
from server.jobs import JobManager
from storage import Database, FileManager
from utils.logger import setup_logger
from utils.validators import is_short_url, normalize_short_url

logger = setup_logger("REST")


class DownloadRequest(BaseModel):
    url: str
    mode: Optional[List[str]] = None
    start_time: Optional[str] = None
    end_time: Optional[str] = None
    number: Optional[Dict[str, int]] = None
    increment: Optional[bool] = None
    output_dir: Optional[str] = None


class JobResponse(BaseModel):
    job_id: str
    status: str
    url: str


class CookiesPayload(BaseModel):
    cookies: Dict[str, str]


class SettingsPatch(BaseModel):
    path: Optional[str] = None
    thread: Optional[int] = None
    rate_limit: Optional[float] = None


class _ServerDeps:
    """跨请求复用的重量级依赖。

    REST 服务在进程生命周期内只需要一份 FileManager / RateLimiter / RetryHandler /
    QueueManager / CookieManager；每个请求重新构造既浪费又会触发文件系统 mkdir。
    DouyinAPIClient 由于持有 aiohttp.ClientSession，依旧按请求创建，避免跨请求泄漏
    连接状态或触发 "Session is closed" 错误。
    """

    def __init__(self, config: ConfigLoader):
        self.config = config
        self.cookie_manager = CookieManager()
        self.cookie_manager.set_cookies(config.get_cookies())
        self.file_manager = FileManager(config.get("path"))
        self.rate_limiter = RateLimiter(
            max_per_second=float(config.get("rate_limit", 2) or 2)
        )
        self.retry_handler = RetryHandler(
            max_retries=int(config.get("retry_times", 3) or 3)
        )
        self.queue_manager = QueueManager(
            max_workers=int(config.get("thread", 5) or 5)
        )


async def _execute_download(
    url: str,
    deps: "_ServerDeps",
    *,
    reporter: Any = None,
    overrides: Optional[Dict[str, Any]] = None,
) -> Dict[str, int]:
    """简化版 download_url：只负责执行并返回成功/失败计数。

    有意不复用 cli.main.download_url —— 后者绑定了 progress_display 的 rich 状态。
    API client 仍按请求创建（aiohttp session 不跨请求复用）；其余重量级依赖从
    _ServerDeps 共享。
    """
    snap: Dict[str, Any] = {}
    if overrides:
        for k in overrides.keys():
            snap[k] = deps.config.get(k)
        deps.config.update(**overrides)

    try:
        async with DouyinAPIClient(deps.cookie_manager.get_cookies()) as api_client:
            if is_short_url(url):
                resolved = await api_client.resolve_short_url(normalize_short_url(url))
                if not resolved:
                    raise RuntimeError(f"Failed to resolve short URL: {url}")
                url = resolved

            parsed = URLParser.parse(url)
            if not parsed:
                raise RuntimeError(f"Unsupported URL: {url}")

            if reporter is not None:
                reporter.on_job_start(
                    url=url, url_type=parsed["type"], total=None
                )

            downloader = DownloaderFactory.create(
                parsed["type"],
                deps.config,
                api_client,
                deps.file_manager,
                deps.cookie_manager,
                None,  # database 不在 server 场景里启用，避免单例冲突
                deps.rate_limiter,
                deps.retry_handler,
                deps.queue_manager,
                progress_reporter=reporter,
            )
            if downloader is None:
                raise RuntimeError(f"No downloader for url_type={parsed['type']}")

            result = await downloader.download(parsed)
            counts = {
                "total": result.total,
                "success": result.success,
                "failed": result.failed,
                "skipped": result.skipped,
            }
            if reporter is not None:
                reporter.on_job_done(**counts)
            return counts
    finally:
        if overrides:
            deps.config.update(**snap)


def build_app(config: ConfigLoader) -> FastAPI:
    deps = _ServerDeps(config)

    async def executor(
        url: str,
        *,
        reporter: Any = None,
        overrides: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, int]:
        return await _execute_download(
            url, deps, reporter=reporter, overrides=overrides
        )

    server_cfg = config.get("server") or {}
    if not isinstance(server_cfg, dict):
        server_cfg = {}
    manager = JobManager(
        executor=executor,
        max_concurrency=int(config.get("thread", 2) or 2),
        max_jobs=int(server_cfg.get("max_jobs") or JobManager.DEFAULT_MAX_JOBS),
        job_ttl_seconds=float(
            server_cfg.get("job_ttl_seconds") or JobManager.DEFAULT_JOB_TTL_SECONDS
        ),
    )

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        yield
        await manager.shutdown()
        db = getattr(app.state, "history_db", None)
        if db is not None:
            try:
                await db.close()
            except Exception:  # pragma: no cover
                logger.warning("Failed to close history DB cleanly")

    app = FastAPI(
        title="Douyin Downloader API",
        version="1.0",
        description="REST API for dispatching Douyin download jobs.",
        lifespan=lifespan,
    )
    app.state.job_manager = manager
    app.state.deps = deps
    app.state.history_db = None

    @app.get("/api/v1/health")
    async def health() -> Dict[str, str]:
        return {"status": "ok"}

    @app.post("/api/v1/download", response_model=JobResponse)
    async def create_job(req: DownloadRequest) -> JobResponse:
        if not req.url:
            raise HTTPException(status_code=400, detail="url is required")
        overrides = {
            k: v for k, v in {
                "mode": req.mode,
                "start_time": req.start_time,
                "end_time": req.end_time,
                "number": req.number,
                "increment": req.increment,
                "path": req.output_dir,
            }.items() if v is not None
        }
        job = await manager.submit(req.url, overrides=overrides)
        return JobResponse(job_id=job.job_id, status=job.status, url=job.url)

    @app.get("/api/v1/jobs/{job_id}")
    async def get_job(job_id: str) -> Dict[str, Any]:
        job = await manager.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="job not found")
        return job.to_dict()

    @app.get("/api/v1/jobs")
    async def list_jobs() -> Dict[str, List[Dict[str, Any]]]:
        jobs = await manager.list_jobs()
        return {"jobs": [j.to_dict() for j in jobs]}

    @app.post("/api/v1/jobs/{job_id}/cancel")
    async def cancel_job(job_id: str) -> Dict[str, Any]:
        ok = await manager.cancel(job_id)
        if not ok:
            raise HTTPException(
                status_code=404, detail="job not found or already terminal"
            )
        return {"ok": True}

    @app.get("/api/v1/jobs/{job_id}/events")
    async def job_events(job_id: str, request: Request):
        job = await manager.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="job not found")

        async def event_gen():
            while True:
                if await request.is_disconnected():
                    return
                try:
                    item = await asyncio.wait_for(job.events.get(), timeout=15.0)
                except asyncio.TimeoutError:
                    yield {"event": "ping", "data": "{}"}
                    continue
                if item.get("event") == "_eof":
                    return
                yield {"event": item["event"], "data": json.dumps(item["data"])}

        return EventSourceResponse(event_gen())

    @app.post("/api/v1/cookies")
    async def set_cookies(payload: CookiesPayload) -> Dict[str, Any]:
        deps.cookie_manager.set_cookies(payload.cookies)
        deps.cookie_manager._save_cookies()
        return {"ok": True}

    @app.get("/api/v1/cookies/status")
    async def cookies_status() -> Dict[str, Any]:
        cookies = deps.cookie_manager.get_cookies() or {}
        required = ("sessionid_ss", "ttwid", "passport_csrf_token")
        logged_in = all(cookies.get(k) for k in required)
        return {"logged_in": bool(logged_in)}

    async def _get_history_db() -> Database:
        if app.state.history_db is None:
            db_path = (
                config.get("database_path", "dy_downloader.db")
                or "dy_downloader.db"
            )
            db = Database(db_path=str(db_path))
            await db.initialize()
            app.state.history_db = db
        return app.state.history_db

    @app.get("/api/v1/history")
    async def history(
        page: int = 1,
        size: int = 50,
        author: Optional[str] = None,
        date_from: Optional[int] = None,
        date_to: Optional[int] = None,
        aweme_type: Optional[str] = None,
    ) -> Dict[str, Any]:
        db = await _get_history_db()
        return await db.get_aweme_history(
            page=page,
            size=size,
            author=author,
            date_from=date_from,
            date_to=date_to,
            aweme_type=aweme_type,
        )

    @app.get("/api/v1/settings")
    async def get_settings() -> Dict[str, Any]:
        return {
            "path": str(config.get("path") or ""),
            "thread": int(config.get("thread", 5) or 5),
            "rate_limit": float(config.get("rate_limit", 2) or 2),
        }

    @app.post("/api/v1/settings")
    async def patch_settings(patch: SettingsPatch) -> Dict[str, Any]:
        updates: Dict[str, Any] = {}
        if patch.path is not None:
            updates["path"] = patch.path
            try:
                Path(patch.path).mkdir(parents=True, exist_ok=True)
            except OSError as exc:
                raise HTTPException(
                    status_code=400, detail=f"cannot create path: {exc}"
                )
        if patch.thread is not None:
            updates["thread"] = int(patch.thread)
        if patch.rate_limit is not None:
            updates["rate_limit"] = float(patch.rate_limit)
        if updates:
            config.update(**updates)
        return await get_settings()

    return app


async def run_server(config: ConfigLoader, *, host: str, port: int) -> None:
    """Legacy entry kept for backwards compat — simple blocking serve."""
    import uvicorn

    app = build_app(config)
    uv_config = uvicorn.Config(app, host=host, port=port, log_level="info")
    server = uvicorn.Server(uv_config)
    await server.serve()


async def run_server_and_announce(
    config: ConfigLoader, *, host: str, port: int
) -> None:
    """Start uvicorn on port (0 → OS-assigned) and announce readiness on stdout.

    Emits a single line `DOUYIN_SIDECAR_READY port=<int> pid=<int>` to stdout
    once the socket is bound; Electron Main reads this line to know the port.
    """
    import uvicorn

    app = build_app(config)
    uv_config = uvicorn.Config(app, host=host, port=port, log_level="warning")
    server = uvicorn.Server(uv_config)

    async def _announce_after_startup() -> None:
        while not server.started:
            await asyncio.sleep(0.05)
        bound_port = port
        for s in server.servers:
            for sock in s.sockets:
                try:
                    bound_port = sock.getsockname()[1]
                except Exception:
                    continue
                break
            break
        sys.stdout.write(
            f"DOUYIN_SIDECAR_READY port={bound_port} pid={os.getpid()}\n"
        )
        sys.stdout.flush()

    await asyncio.gather(server.serve(), _announce_after_startup())
