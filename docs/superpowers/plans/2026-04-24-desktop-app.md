# Desktop App (Electron) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a macOS `.dmg` and Windows `.exe` desktop installer that wraps
the existing `douyin-downloader` Python backend, enabling non-technical users
to download Douyin content without CLI or manual cookie handling.

**Architecture:** Three-process Electron app — Main (Node.js) spawns a
PyInstaller-bundled Python FastAPI sidecar on `127.0.0.1:<random-port>`;
Renderer (React) talks to Python via HTTP + Server-Sent Events; Main owns
sidecar lifecycle and an embedded Douyin login BrowserWindow for cookie
capture.

**Tech Stack:** Python 3.11 + FastAPI + sse-starlette + PyInstaller;
Electron 29 + Vite + React 18 + TypeScript + Zustand + Tailwind + shadcn/ui;
electron-builder for packaging, electron-updater + GitHub Releases for
auto-update.

**Spec reference:** `docs/superpowers/specs/2026-04-24-desktop-app-electron-design.md`

---

## File Structure Overview

### Modified (Python)
- `pyproject.toml` — add `sse-starlette` to server extras
- `server/app.py` — add cookies/history/events/cancel/settings endpoints
- `server/jobs.py` — add per-job event queue + cancel
- `control/__init__.py` — export new `ProgressReporter` base
- `control/progress_reporter.py` (new) — abstract base + SSE implementation
- `storage/database.py` — add `get_aweme_history(...)` query method

### Created (Electron)
- `desktop/package.json`
- `desktop/tsconfig.json`, `desktop/tsconfig.node.json`
- `desktop/vite.config.ts`
- `desktop/electron-builder.yml`
- `desktop/index.html`
- `desktop/src/main/index.ts`
- `desktop/src/main/sidecar.ts`
- `desktop/src/main/login-window.ts`
- `desktop/src/main/ipc.ts`
- `desktop/src/main/auto-update.ts`
- `desktop/src/preload/index.ts`
- `desktop/src/renderer/main.tsx`
- `desktop/src/renderer/App.tsx`
- `desktop/src/renderer/pages/{Home,Batch,History,Settings}.tsx`
- `desktop/src/renderer/components/` (various)
- `desktop/src/renderer/api/client.ts`
- `desktop/src/renderer/api/sse.ts`
- `desktop/src/renderer/store/index.ts`
- `desktop/src/shared/types.ts`
- `desktop/scripts/build-sidecar.sh`
- `desktop/scripts/dev-run.sh`
- `desktop/resources/entitlements.mac.plist`
- `desktop/README.md`

### Tests
- `tests/test_server_extensions.py` (new) — Python API extensions
- `tests/test_progress_reporter.py` (new)
- `tests/test_database_history.py` (new)
- `desktop/src/main/__tests__/sidecar.test.ts`
- `desktop/src/main/__tests__/login-window.test.ts`
- `desktop/src/renderer/__tests__/App.test.tsx`

### CI
- `.github/workflows/desktop-release.yml` (new)
- `.gitignore` — add `desktop/node_modules`, `desktop/dist`, `desktop/resources/sidecar/`

---

## Phase 1 — Python Backend Extensions

Pure Python, pytest-verifiable. No UI dependencies. Ships first; CLI continues
to work throughout.

### Task 1.1: Introduce ProgressReporter abstraction

**Files:**
- Create: `control/progress_reporter.py`
- Modify: `control/__init__.py`
- Test: `tests/test_progress_reporter.py`

- [ ] **Step 1: Write failing tests**

```python
# tests/test_progress_reporter.py
import asyncio
import pytest
from control.progress_reporter import (
    ProgressReporter,
    NullProgressReporter,
    QueueProgressReporter,
)


def test_null_reporter_never_raises():
    rep = NullProgressReporter()
    rep.on_job_start(url="x", url_type="video", total=None)
    rep.on_item_start(aweme_id="a1", index=0, total=1, title="t")
    rep.on_item_progress(aweme_id="a1", bytes_read=100, bytes_total=200)
    rep.on_item_complete(aweme_id="a1", status="ok", file_paths=["/tmp/a"])
    rep.on_log(level="info", message="hi")
    rep.on_job_done(total=1, success=1, failed=0, skipped=0)
    rep.on_error(message="oops", fatal=False)


@pytest.mark.asyncio
async def test_queue_reporter_emits_typed_events():
    queue: asyncio.Queue = asyncio.Queue()
    rep = QueueProgressReporter(queue)
    rep.on_job_start(url="https://x", url_type="video", total=1)
    rep.on_item_complete(aweme_id="a1", status="ok", file_paths=["/tmp/x"])
    rep.on_job_done(total=1, success=1, failed=0, skipped=0)

    ev1 = await queue.get()
    ev2 = await queue.get()
    ev3 = await queue.get()
    assert ev1 == {"event": "job-start", "data": {"url": "https://x", "url_type": "video", "total": 1}}
    assert ev2["event"] == "item-complete"
    assert ev2["data"]["aweme_id"] == "a1"
    assert ev3 == {"event": "done", "data": {"total": 1, "success": 1, "failed": 0, "skipped": 0}}


@pytest.mark.asyncio
async def test_queue_reporter_drops_oldest_when_full():
    queue: asyncio.Queue = asyncio.Queue(maxsize=2)
    rep = QueueProgressReporter(queue, drop_when_full=True)
    rep.on_log(level="info", message="1")
    rep.on_log(level="info", message="2")
    rep.on_log(level="info", message="3")  # forces drop of "1"
    ev_a = await queue.get()
    ev_b = await queue.get()
    assert ev_a["data"]["message"] == "2"
    assert ev_b["data"]["message"] == "3"
```

- [ ] **Step 2: Run tests to confirm failure**

```bash
cd /Users/crimson/codes/douyin/douyin-downloader
PYTHONPATH=. pytest tests/test_progress_reporter.py -v
```

Expected: all three tests fail with `ModuleNotFoundError: No module named 'control.progress_reporter'`.

- [ ] **Step 3: Implement ProgressReporter**

```python
# control/progress_reporter.py
"""Progress reporting abstraction used by downloaders.

Two flavors ship:
- NullProgressReporter: no-op, default for library-mode callers.
- QueueProgressReporter: pushes typed events onto an asyncio.Queue, consumed
  by the SSE broker in server/app.py.

The CLI keeps using cli.progress_display.ProgressDisplay directly (separate
concern — rich-based terminal UI, not event-shaped).
"""
from __future__ import annotations

import asyncio
from typing import Any, Dict, List, Optional, Protocol


class ProgressReporter(Protocol):
    def on_job_start(self, *, url: str, url_type: str, total: Optional[int]) -> None: ...
    def on_item_start(self, *, aweme_id: str, index: int, total: int, title: str) -> None: ...
    def on_item_progress(self, *, aweme_id: str, bytes_read: int, bytes_total: int) -> None: ...
    def on_item_complete(self, *, aweme_id: str, status: str, file_paths: List[str]) -> None: ...
    def on_log(self, *, level: str, message: str, type: Optional[str] = None) -> None: ...
    def on_job_done(self, *, total: int, success: int, failed: int, skipped: int) -> None: ...
    def on_error(self, *, message: str, fatal: bool) -> None: ...


class NullProgressReporter:
    def on_job_start(self, **kwargs: Any) -> None: pass
    def on_item_start(self, **kwargs: Any) -> None: pass
    def on_item_progress(self, **kwargs: Any) -> None: pass
    def on_item_complete(self, **kwargs: Any) -> None: pass
    def on_log(self, **kwargs: Any) -> None: pass
    def on_job_done(self, **kwargs: Any) -> None: pass
    def on_error(self, **kwargs: Any) -> None: pass


class QueueProgressReporter:
    """Push structured events onto a queue for SSE fan-out.

    When drop_when_full=True (the SSE default), a full queue causes the
    oldest event to be dropped rather than blocking the downloader. This
    protects long-running jobs from back-pressuring when no UI is attached.
    """

    def __init__(self, queue: asyncio.Queue, *, drop_when_full: bool = True):
        self._queue = queue
        self._drop_when_full = drop_when_full

    def _emit(self, event: str, data: Dict[str, Any]) -> None:
        payload = {"event": event, "data": data}
        try:
            self._queue.put_nowait(payload)
        except asyncio.QueueFull:
            if not self._drop_when_full:
                raise
            # Drop oldest to make room
            try:
                self._queue.get_nowait()
            except asyncio.QueueEmpty:
                pass
            try:
                self._queue.put_nowait(payload)
            except asyncio.QueueFull:
                pass  # give up; avoid infinite loop

    def on_job_start(self, *, url: str, url_type: str, total: Optional[int]) -> None:
        self._emit("job-start", {"url": url, "url_type": url_type, "total": total})

    def on_item_start(self, *, aweme_id: str, index: int, total: int, title: str) -> None:
        self._emit("item-start", {"aweme_id": aweme_id, "index": index, "total": total, "title": title})

    def on_item_progress(self, *, aweme_id: str, bytes_read: int, bytes_total: int) -> None:
        self._emit("item-progress", {"aweme_id": aweme_id, "bytes_read": bytes_read, "bytes_total": bytes_total})

    def on_item_complete(self, *, aweme_id: str, status: str, file_paths: List[str]) -> None:
        self._emit("item-complete", {"aweme_id": aweme_id, "status": status, "file_paths": file_paths})

    def on_log(self, *, level: str, message: str, type: Optional[str] = None) -> None:
        data = {"level": level, "message": message}
        if type:
            data["type"] = type
        self._emit("log", data)

    def on_job_done(self, *, total: int, success: int, failed: int, skipped: int) -> None:
        self._emit("done", {"total": total, "success": success, "failed": failed, "skipped": skipped})

    def on_error(self, *, message: str, fatal: bool) -> None:
        self._emit("error", {"message": message, "fatal": fatal})
```

```python
# control/__init__.py (append)
from .progress_reporter import (
    NullProgressReporter,
    ProgressReporter,
    QueueProgressReporter,
)
```

- [ ] **Step 4: Run tests; expect PASS**

```bash
PYTHONPATH=. pytest tests/test_progress_reporter.py -v
```

- [ ] **Step 5: Run full test suite to confirm no regression**

```bash
PYTHONPATH=. pytest -q
```

Expected: 74 passed (71 existing + 3 new).

- [ ] **Step 6: Commit**

```bash
git add control/progress_reporter.py control/__init__.py tests/test_progress_reporter.py
git commit -m "feat(control): add ProgressReporter abstraction with queue implementation"
```

---

### Task 1.2: Add sse-starlette dependency

**Files:**
- Modify: `pyproject.toml`

- [ ] **Step 1: Update `server` extras**

In `pyproject.toml`, change the `server` extra from:
```toml
server = [
    "fastapi>=0.100",
    "uvicorn>=0.23",
    "pydantic>=2.0",
]
```
to:
```toml
server = [
    "fastapi>=0.100",
    "uvicorn>=0.23",
    "pydantic>=2.0",
    "sse-starlette>=2.1.0",
]
```

- [ ] **Step 2: Install locally**

```bash
pip install -e ".[server,dev]"
```

- [ ] **Step 3: Commit**

```bash
git add pyproject.toml
git commit -m "chore: add sse-starlette to server extras"
```

---

### Task 1.3: Add per-job event queue to JobManager

**Files:**
- Modify: `server/jobs.py`
- Test: `tests/test_server_extensions.py` (new)

- [ ] **Step 1: Write failing tests**

```python
# tests/test_server_extensions.py
import asyncio
import pytest
from server.jobs import DownloadJob, JobManager, JobStatus


@pytest.mark.asyncio
async def test_job_has_event_queue():
    job = DownloadJob(job_id="x", url="https://v.douyin.com/abc")
    assert hasattr(job, "events")
    assert isinstance(job.events, asyncio.Queue)


@pytest.mark.asyncio
async def test_submit_creates_job_with_events():
    async def fake_exec(url, reporter=None):
        if reporter is not None:
            reporter.on_job_done(total=1, success=1, failed=0, skipped=0)
        return {"total": 1, "success": 1, "failed": 0, "skipped": 0}

    mgr = JobManager(executor=fake_exec, max_concurrency=1)
    job = await mgr.submit(url="https://v.douyin.com/abc")
    # Let the task run
    await asyncio.sleep(0.1)
    # Drain queue
    events = []
    while not job.events.empty():
        events.append(job.events.get_nowait())
    # Last event should be "done"
    assert any(e["event"] == "done" for e in events)


@pytest.mark.asyncio
async def test_cancel_transitions_job_to_cancelled():
    started = asyncio.Event()
    release = asyncio.Event()

    async def slow_exec(url, reporter=None):
        started.set()
        await release.wait()
        return {"total": 0, "success": 0, "failed": 0, "skipped": 0}

    mgr = JobManager(executor=slow_exec, max_concurrency=1)
    job = await mgr.submit(url="https://x")
    await started.wait()
    ok = await mgr.cancel(job.job_id)
    assert ok is True
    # Give the cancellation a tick to propagate
    await asyncio.sleep(0.05)
    job2 = await mgr.get(job.job_id)
    assert job2.status == JobStatus.CANCELLED
```

- [ ] **Step 2: Run tests; confirm failure**

```bash
PYTHONPATH=. pytest tests/test_server_extensions.py -v
```

Expected: fails — `events` attribute missing, `CANCELLED` missing, `cancel()` missing.

- [ ] **Step 3: Modify `server/jobs.py`**

At the top of the file, add `CANCELLING` and `CANCELLED` states:

```python
class JobStatus:
    PENDING = "pending"
    RUNNING = "running"
    SUCCESS = "success"
    FAILED = "failed"
    CANCELLING = "cancelling"
    CANCELLED = "cancelled"

    TERMINAL = frozenset({SUCCESS, FAILED, CANCELLED})
```

In `DownloadJob.__init__`, append:
```python
        self.events: asyncio.Queue = asyncio.Queue(maxsize=1000)
```

Modify `JobManager.__init__` signature — `executor` may now receive a
`reporter` keyword argument. Keep the old signature working by detecting
whether it accepts `reporter`:

```python
# near top of file
import inspect

# in JobManager._run, replace the `counts = await self.executor(job.url)` line:
        try:
            from control.progress_reporter import QueueProgressReporter
            reporter = QueueProgressReporter(job.events)
            if _executor_accepts_reporter(self.executor):
                counts = await self.executor(job.url, reporter=reporter)
            else:
                counts = await self.executor(job.url)
            ...
        except asyncio.CancelledError:
            job.status = JobStatus.CANCELLED
            job.error = "cancelled"
            raise
        except Exception as exc:
            ...

# helper at module level:
def _executor_accepts_reporter(func) -> bool:
    try:
        sig = inspect.signature(func)
        return "reporter" in sig.parameters
    except (TypeError, ValueError):
        return False
```

Add `cancel()` method:

```python
    async def cancel(self, job_id: str) -> bool:
        async with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return False
            if job.status in JobStatus.TERMINAL:
                return False
            job.status = JobStatus.CANCELLING
            task = job._task
        if task is not None and not task.done():
            task.cancel()
        return True
```

Also update `_run`'s `finally` block so `CANCELLED` is recorded without
being overwritten:

```python
            except asyncio.CancelledError:
                job.status = JobStatus.CANCELLED
                job.error = job.error or "cancelled"
                raise
            except Exception as exc:
                job.status = JobStatus.FAILED
                job.error = f"{type(exc).__name__}: {exc}"
            finally:
                job.finished_at = _now_iso()
                job.finished_monotonic = time.monotonic()
                # Signal end-of-stream to any SSE consumer
                try:
                    job.events.put_nowait({"event": "_eof", "data": {}})
                except asyncio.QueueFull:
                    pass
```

The existing logic that sets `SUCCESS`/`FAILED` based on counts must only
run when no exception was raised — wrap it in an `else:` off the try:

```python
        async with self._semaphore:
            job.status = JobStatus.RUNNING
            job.started_at = _now_iso()
            try:
                ...
                counts = ...
            except asyncio.CancelledError:
                job.status = JobStatus.CANCELLED
                job.error = job.error or "cancelled"
                raise
            except Exception as exc:
                job.status = JobStatus.FAILED
                job.error = f"{type(exc).__name__}: {exc}"
            else:
                job.total = int(counts.get("total", 0))
                job.success = int(counts.get("success", 0))
                job.failed = int(counts.get("failed", 0))
                job.skipped = int(counts.get("skipped", 0))
                job.status = (
                    JobStatus.SUCCESS if job.failed == 0 else JobStatus.FAILED
                )
            finally:
                ...
```

- [ ] **Step 4: Run tests; expect PASS**

```bash
PYTHONPATH=. pytest tests/test_server_extensions.py -v tests/test_progress_reporter.py -v
```

- [ ] **Step 5: Run full suite, no regression**

```bash
PYTHONPATH=. pytest -q
```

- [ ] **Step 6: Commit**

```bash
git add server/jobs.py tests/test_server_extensions.py
git commit -m "feat(server): per-job event queue, cancellation, reporter wiring"
```

---

### Task 1.4: Add SSE, cookies, history, cancel, settings endpoints

**Files:**
- Modify: `server/app.py`
- Modify: `storage/database.py` (add `get_aweme_history`)
- Test: `tests/test_server_extensions.py` (extend)
- Test: `tests/test_database_history.py` (new)

- [ ] **Step 1: Add failing test for `get_aweme_history`**

```python
# tests/test_database_history.py
import os
import tempfile
import pytest
from storage.database import Database


@pytest.mark.asyncio
async def test_get_aweme_history_paginates():
    with tempfile.TemporaryDirectory() as td:
        db = Database(db_path=os.path.join(td, "t.db"))
        await db.initialize()
        for i in range(5):
            await db.add_aweme({
                "aweme_id": f"id{i}",
                "author_id": "u1",
                "author_name": "A",
                "description": f"desc{i}",
                "create_time": 1700000000 + i,
                "url_type": "video",
                "save_path": f"/tmp/{i}",
                "metadata": "{}",
            })
        page1 = await db.get_aweme_history(page=1, size=2)
        page2 = await db.get_aweme_history(page=2, size=2)
        assert len(page1["items"]) == 2
        assert len(page2["items"]) == 2
        assert page1["total"] == 5
        # Sort: newest first
        assert int(page1["items"][0]["aweme_id"][-1]) > int(page1["items"][1]["aweme_id"][-1])
        await db.close()


@pytest.mark.asyncio
async def test_get_aweme_history_filters_by_author():
    with tempfile.TemporaryDirectory() as td:
        db = Database(db_path=os.path.join(td, "t.db"))
        await db.initialize()
        await db.add_aweme({
            "aweme_id": "a", "author_id": "u1", "author_name": "Alice",
            "description": "", "create_time": 0, "url_type": "video",
            "save_path": "/tmp/a", "metadata": "{}",
        })
        await db.add_aweme({
            "aweme_id": "b", "author_id": "u2", "author_name": "Bob",
            "description": "", "create_time": 0, "url_type": "video",
            "save_path": "/tmp/b", "metadata": "{}",
        })
        res = await db.get_aweme_history(page=1, size=10, author="Alice")
        assert len(res["items"]) == 1
        assert res["items"][0]["author_name"] == "Alice"
        await db.close()
```

- [ ] **Step 2: Run tests; confirm failure**

```bash
PYTHONPATH=. pytest tests/test_database_history.py -v
```

Expected: `AttributeError: 'Database' object has no attribute 'get_aweme_history'`.

- [ ] **Step 3: Add `get_aweme_history` to `storage/database.py`**

Insert after `get_aweme_count_by_author`:

```python
    async def get_aweme_history(
        self,
        *,
        page: int = 1,
        size: int = 50,
        author: str | None = None,
        date_from: int | None = None,
        date_to: int | None = None,
        url_type: str | None = None,
    ) -> Dict[str, Any]:
        """Paginated aweme history, newest first.

        `date_from` / `date_to` are unix-seconds (matches `create_time` column).
        """
        conn = await self._get_conn()
        where: list[str] = []
        params: list[Any] = []
        if author:
            where.append("author_name = ?")
            params.append(author)
        if date_from is not None:
            where.append("create_time >= ?")
            params.append(date_from)
        if date_to is not None:
            where.append("create_time <= ?")
            params.append(date_to)
        if url_type:
            where.append("url_type = ?")
            params.append(url_type)
        where_sql = ("WHERE " + " AND ".join(where)) if where else ""

        # total
        async with conn.execute(f"SELECT COUNT(*) FROM aweme {where_sql}", params) as cur:
            row = await cur.fetchone()
            total = int(row[0]) if row else 0

        # page
        offset = max(0, (page - 1) * size)
        async with conn.execute(
            f"SELECT aweme_id, author_id, author_name, description, create_time, "
            f"url_type, save_path, download_time FROM aweme {where_sql} "
            f"ORDER BY download_time DESC LIMIT ? OFFSET ?",
            params + [size, offset],
        ) as cur:
            rows = await cur.fetchall()

        items = [
            {
                "aweme_id": r[0],
                "author_id": r[1],
                "author_name": r[2],
                "description": r[3],
                "create_time": r[4],
                "url_type": r[5],
                "save_path": r[6],
                "download_time": r[7],
            }
            for r in rows
        ]
        return {"total": total, "page": page, "size": size, "items": items}
```

- [ ] **Step 4: Tests pass**

```bash
PYTHONPATH=. pytest tests/test_database_history.py -v
```

- [ ] **Step 5: Commit**

```bash
git add storage/database.py tests/test_database_history.py
git commit -m "feat(storage): add get_aweme_history with filters + pagination"
```

- [ ] **Step 6: Add endpoint tests (failing)**

Append to `tests/test_server_extensions.py`:

```python
import pytest
from httpx import ASGITransport, AsyncClient


async def _build_test_app(tmp_path):
    from config import ConfigLoader
    from server.app import build_app
    config = ConfigLoader(None)
    config.update(path=str(tmp_path), cookies={})
    app = build_app(config)
    return app


@pytest.mark.asyncio
async def test_health(tmp_path):
    app = await _build_test_app(tmp_path)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        r = await c.get("/api/v1/health")
        assert r.status_code == 200
        assert r.json()["status"] == "ok"


@pytest.mark.asyncio
async def test_set_cookies_roundtrip(tmp_path):
    app = await _build_test_app(tmp_path)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        r = await c.post("/api/v1/cookies", json={"cookies": {"sessionid_ss": "abc", "ttwid": "t1"}})
        assert r.status_code == 200
        assert r.json()["ok"] is True
        s = await c.get("/api/v1/cookies/status")
        assert s.status_code == 200
        body = s.json()
        assert body["logged_in"] in (True, False)  # shape stable


@pytest.mark.asyncio
async def test_cookies_empty_dict_means_logged_out(tmp_path):
    app = await _build_test_app(tmp_path)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        r = await c.get("/api/v1/cookies/status")
        assert r.status_code == 200
        assert r.json()["logged_in"] is False


@pytest.mark.asyncio
async def test_history_empty(tmp_path):
    app = await _build_test_app(tmp_path)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        r = await c.get("/api/v1/history")
        assert r.status_code == 200
        body = r.json()
        assert body["total"] == 0
        assert body["items"] == []


@pytest.mark.asyncio
async def test_settings_get_and_patch(tmp_path):
    app = await _build_test_app(tmp_path)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        r = await c.get("/api/v1/settings")
        assert r.status_code == 200
        body = r.json()
        assert "path" in body and "thread" in body and "rate_limit" in body
        r2 = await c.post("/api/v1/settings", json={"thread": 7, "rate_limit": 1.5})
        assert r2.status_code == 200
        r3 = await c.get("/api/v1/settings")
        assert r3.json()["thread"] == 7
        assert r3.json()["rate_limit"] == 1.5
```

- [ ] **Step 7: Confirm test failure**

```bash
PYTHONPATH=. pytest tests/test_server_extensions.py -v
```

Expected: the new endpoint tests fail with 404.

- [ ] **Step 8: Implement endpoints in `server/app.py`**

Imports to add at top:
```python
import asyncio
import json
from pathlib import Path
from fastapi import Request
from sse_starlette.sse import EventSourceResponse

from storage import Database
```

Replace the old `build_app` body — keep `POST /api/v1/download` /
`GET /api/v1/jobs/{job_id}` / `GET /api/v1/jobs` / `GET /api/v1/health`
endpoints as they are, then add the following inside `build_app` before
`return app`:

```python
    # -------- cookies --------
    class CookiesPayload(BaseModel):
        cookies: Dict[str, str]

    @app.post("/api/v1/cookies")
    async def set_cookies(payload: CookiesPayload) -> Dict[str, Any]:
        deps.cookie_manager.set_cookies(payload.cookies)
        # Persist via CookieManager's private helper
        deps.cookie_manager._save_cookies()
        return {"ok": True}

    @app.get("/api/v1/cookies/status")
    async def cookies_status() -> Dict[str, Any]:
        cookies = deps.cookie_manager.get_cookies()
        required = ("sessionid_ss", "ttwid", "passport_csrf_token")
        logged_in = all(cookies.get(k) for k in required)
        return {"logged_in": logged_in}

    # -------- history --------
    async def _get_db() -> Database:
        if not hasattr(app.state, "history_db") or app.state.history_db is None:
            db_path = config.get("database_path", "dy_downloader.db") or "dy_downloader.db"
            db = Database(db_path=str(db_path))
            await db.initialize()
            app.state.history_db = db
        return app.state.history_db

    @app.get("/api/v1/history")
    async def history(
        page: int = 1,
        size: int = 50,
        author: str | None = None,
        date_from: int | None = None,
        date_to: int | None = None,
        url_type: str | None = None,
    ) -> Dict[str, Any]:
        db = await _get_db()
        return await db.get_aweme_history(
            page=page,
            size=size,
            author=author,
            date_from=date_from,
            date_to=date_to,
            url_type=url_type,
        )

    # -------- jobs cancel + events --------
    @app.post("/api/v1/jobs/{job_id}/cancel")
    async def cancel_job(job_id: str) -> Dict[str, Any]:
        ok = await manager.cancel(job_id)
        if not ok:
            raise HTTPException(status_code=404, detail="job not found or already terminal")
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
                    # Heartbeat to keep the stream alive behind proxies
                    yield {"event": "ping", "data": "{}"}
                    continue
                if item.get("event") == "_eof":
                    return
                yield {"event": item["event"], "data": json.dumps(item["data"])}
        return EventSourceResponse(event_gen())

    # -------- settings --------
    class SettingsPatch(BaseModel):
        path: Optional[str] = None
        thread: Optional[int] = None
        rate_limit: Optional[float] = None

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
            Path(patch.path).mkdir(parents=True, exist_ok=True)
        if patch.thread is not None:
            updates["thread"] = int(patch.thread)
        if patch.rate_limit is not None:
            updates["rate_limit"] = float(patch.rate_limit)
        if updates:
            config.update(**updates)
        return await get_settings()
```

Also extend `DownloadRequest` and `_execute_download` so batch/mode params
flow through:

```python
class DownloadRequest(BaseModel):
    url: str
    mode: Optional[List[str]] = None
    start_time: Optional[str] = None
    end_time: Optional[str] = None
    number: Optional[Dict[str, int]] = None
    increment: Optional[bool] = None
    output_dir: Optional[str] = None
```

In `create_job`:
```python
    @app.post("/api/v1/download", response_model=JobResponse)
    async def create_job(req: DownloadRequest) -> JobResponse:
        if not req.url:
            raise HTTPException(status_code=400, detail="url is required")
        # Per-request config overlay — we pass overrides via a side channel on the job
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
```

The `JobManager.submit` signature gains `overrides: Optional[Dict]`. Persist
it on the job and pass to executor:

```python
# server/jobs.py
    async def submit(self, url: str, *, overrides: Optional[Dict[str, Any]] = None) -> DownloadJob:
        ...
        job = DownloadJob(job_id=job_id, url=url)
        job.overrides = overrides or {}
        ...

    async def _run(self, job: DownloadJob) -> None:
        ...
            if _executor_accepts_reporter(self.executor):
                counts = await self.executor(job.url, reporter=reporter, overrides=job.overrides)
            else:
                counts = await self.executor(job.url)
```

And extend `_execute_download` to take `overrides` + apply them before
creating the downloader (patch `config` in place for the scope of this call
by wrapping it in a transient overlay — simplest implementation: shallow
`config.update(**overrides)` before, restore original values after in a
`try/finally`). Show the implementation:

```python
async def _execute_download(
    url: str,
    deps: "_ServerDeps",
    *,
    reporter: Optional[Any] = None,
    overrides: Optional[Dict[str, Any]] = None,
) -> Dict[str, int]:
    # Snapshot values we may overwrite so we can restore after
    snap = {}
    if overrides:
        for k in overrides.keys():
            snap[k] = deps.config.get(k)
        deps.config.update(**overrides)
    try:
        async with DouyinAPIClient(deps.cookie_manager.get_cookies()) as api_client:
            ...
            downloader = DownloaderFactory.create(
                ...,
                progress_reporter=reporter,
            )
            ...
    finally:
        if overrides:
            deps.config.update(**snap)
```

And the `executor` closure signature:
```python
    async def executor(url: str, *, reporter=None, overrides=None) -> Dict[str, int]:
        return await _execute_download(url, deps, reporter=reporter, overrides=overrides)
```

- [ ] **Step 9: Run tests; expect PASS**

```bash
PYTHONPATH=. pytest tests/test_server_extensions.py tests/test_progress_reporter.py tests/test_database_history.py -v
```

- [ ] **Step 10: Run full suite**

```bash
PYTHONPATH=. pytest -q
```

Expected: no regressions.

- [ ] **Step 11: Commit**

```bash
git add server/app.py server/jobs.py tests/test_server_extensions.py
git commit -m "feat(server): add SSE, cookies, history, cancel, settings endpoints"
```

---

### Task 1.5: Smoke-test SSE against live server

**Files:** none (manual verification)

- [ ] **Step 1: Start server**

```bash
python -m cli.main --serve --serve-host 127.0.0.1 --serve-port 8765
```

- [ ] **Step 2: Hit SSE endpoint with curl from another shell**

```bash
curl -N http://127.0.0.1:8765/api/v1/health   # sanity
JOB=$(curl -s -X POST http://127.0.0.1:8765/api/v1/download \
    -H 'Content-Type: application/json' \
    -d '{"url":"https://v.douyin.com/placeholder"}' | jq -r .job_id)
curl -N "http://127.0.0.1:8765/api/v1/jobs/${JOB}/events"
```

Expected: `event: error` (because the placeholder URL fails), followed by
stream close. Proves SSE framing works. Record the curl transcript as evidence.

- [ ] **Step 3: Stop server with Ctrl+C. No commit needed (read-only test).**

---

### Task 1.6: Update CLI to emit sidecar-ready marker

**Files:**
- Modify: `cli/main.py` (`_run_serve_subcommand` only)
- Test: `tests/test_serve_marker.py` (new)

- [ ] **Step 1: Failing test (subprocess-based)**

```python
# tests/test_serve_marker.py
import os
import re
import signal
import subprocess
import sys
import time
from pathlib import Path

import pytest


@pytest.mark.skipif(sys.platform == "win32", reason="signal handling differs on Windows")
def test_serve_emits_ready_marker():
    repo_root = Path(__file__).resolve().parent.parent
    env = {**os.environ, "PYTHONPATH": str(repo_root)}
    proc = subprocess.Popen(
        [sys.executable, "-m", "cli.main", "--serve", "--serve-port", "0"],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd=str(repo_root),
    )
    try:
        line = proc.stdout.readline().decode().strip()
        # First line MUST be the marker (may be preceded by the Banner printed
        # to stderr, which goes to `display.show_banner`). Banner is currently
        # printed to stdout; this test will fail until we move it to stderr in
        # --serve mode OR emit marker explicitly.
        m = re.match(r"DOUYIN_SIDECAR_READY port=(\d+) pid=(\d+)", line)
        assert m is not None, f"expected marker, got: {line!r}"
        port = int(m.group(1))
        assert 1 <= port <= 65535
    finally:
        proc.send_signal(signal.SIGINT)
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
```

- [ ] **Step 2: Run test; confirm failure**

```bash
PYTHONPATH=. pytest tests/test_serve_marker.py -v
```

- [ ] **Step 3: Modify `cli/main.py`**

In `_run_serve_subcommand`, before `await run_server(...)`:

```python
async def _run_serve_subcommand(args, config: ConfigLoader) -> None:
    """启动 REST API 服务模式（fastapi + uvicorn 为可选依赖）。"""
    try:
        from server.app import run_server_and_announce
    except ImportError as exc:
        # Write to stderr so stdout stays clean for the parent Electron process.
        print(
            f"REST 服务模式需要安装可选依赖 fastapi + uvicorn："
            f"\n  pip install fastapi uvicorn\n原始错误：{exc}",
            file=sys.stderr,
        )
        return

    await run_server_and_announce(config, host=args.serve_host, port=args.serve_port)
```

In `cli/main.py::main_async`, wrap the `display.show_banner()` call so the
banner is suppressed in `--serve` mode:
```python
    if not args.serve:
        display.show_banner()
```

Add a new function in `server/app.py`:

```python
async def run_server_and_announce(config: ConfigLoader, *, host: str, port: int) -> None:
    """Start uvicorn on port (0 → OS-assigned) and announce readiness on stdout."""
    import os
    import uvicorn

    app = build_app(config)
    uv_config = uvicorn.Config(app, host=host, port=port, log_level="warning")
    server = uvicorn.Server(uv_config)

    # Emit the marker after uvicorn has bound the socket. We do this by
    # subclassing uvicorn.Server's startup hook: monkey-patch .startup or
    # check servers after startup completes.
    async def _announce_after_startup():
        while not server.started:
            await asyncio.sleep(0.05)
        # pick first bound socket
        bound_port = port
        for s in server.servers:
            for sock in s.sockets:
                bound_port = sock.getsockname()[1]
                break
            break
        sys.stdout.write(f"DOUYIN_SIDECAR_READY port={bound_port} pid={os.getpid()}\n")
        sys.stdout.flush()

    await asyncio.gather(server.serve(), _announce_after_startup())
```

Also add `import sys`, `import asyncio` if missing.

- [ ] **Step 4: Run test; expect PASS**

```bash
PYTHONPATH=. pytest tests/test_serve_marker.py -v
```

- [ ] **Step 5: Full suite green**

```bash
PYTHONPATH=. pytest -q
```

- [ ] **Step 6: Commit**

```bash
git add cli/main.py server/app.py tests/test_serve_marker.py
git commit -m "feat(cli): emit DOUYIN_SIDECAR_READY marker on --serve startup"
```

---

## Phase 2 — Electron Scaffold

Everything from here lives under `desktop/`. Root stays Python-only.

### Task 2.1: Initialize npm project

**Files:**
- Create: `desktop/package.json`
- Create: `desktop/tsconfig.json`, `desktop/tsconfig.node.json`
- Create: `desktop/.gitignore`
- Modify: root `.gitignore`

- [ ] **Step 1: Write `desktop/package.json`**

```json
{
  "name": "douyin-downloader-desktop",
  "version": "0.1.0",
  "private": true,
  "description": "Desktop shell for douyin-downloader",
  "main": "dist-electron/main/index.js",
  "scripts": {
    "dev": "node scripts/dev-run.mjs",
    "build:renderer": "vite build",
    "build:main": "tsc -p tsconfig.node.json",
    "build:sidecar": "bash scripts/build-sidecar.sh",
    "build": "npm run build:renderer && npm run build:main",
    "dist:mac": "npm run build && electron-builder --mac",
    "dist:win": "npm run build && electron-builder --win",
    "typecheck": "tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.node.json",
    "test": "vitest run"
  },
  "devDependencies": {
    "@types/node": "^20.14.0",
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.0",
    "electron": "^29.4.0",
    "electron-builder": "^24.13.3",
    "typescript": "^5.5.0",
    "vite": "^5.3.0",
    "vitest": "^1.6.0",
    "@testing-library/react": "^16.0.0",
    "jsdom": "^24.1.0"
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-router-dom": "^6.24.0",
    "zustand": "^4.5.2",
    "electron-updater": "^6.2.1"
  }
}
```

- [ ] **Step 2: Write `desktop/tsconfig.json`** (for Renderer)

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "lib": ["DOM", "DOM.Iterable", "ES2022"],
    "types": ["vite/client"],
    "baseUrl": ".",
    "paths": {
      "@/*": ["src/renderer/*"],
      "@shared/*": ["src/shared/*"]
    }
  },
  "include": ["src/renderer", "src/shared"]
}
```

- [ ] **Step 3: Write `desktop/tsconfig.node.json`** (for Main + Preload)

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "CommonJS",
    "moduleResolution": "Node",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist-electron",
    "types": ["node"]
  },
  "include": ["src/main", "src/preload", "src/shared"]
}
```

- [ ] **Step 4: Write `desktop/.gitignore`**

```
node_modules/
dist/
dist-electron/
resources/sidecar/
*.log
.vite/
```

- [ ] **Step 5: Append to root `.gitignore`**

```
# Desktop
desktop/node_modules/
desktop/dist/
desktop/dist-electron/
desktop/resources/sidecar/
```

- [ ] **Step 6: Install dependencies**

```bash
cd desktop && npm install
```

Expected: completes without error. May warn about deprecated transitive deps.

- [ ] **Step 7: Commit**

```bash
cd /Users/crimson/codes/douyin/douyin-downloader
git add desktop/package.json desktop/package-lock.json desktop/tsconfig.json desktop/tsconfig.node.json desktop/.gitignore .gitignore
git commit -m "chore(desktop): scaffold npm project, tsconfig, gitignore"
```

---

### Task 2.2: Vite config + index.html

**Files:**
- Create: `desktop/vite.config.ts`
- Create: `desktop/index.html`
- Create: `desktop/src/renderer/main.tsx` (stub)

- [ ] **Step 1: `desktop/vite.config.ts`**

```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

export default defineConfig({
  root: __dirname,
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src/renderer'),
      '@shared': path.resolve(__dirname, 'src/shared'),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
})
```

- [ ] **Step 2: `desktop/index.html`**

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>抖音下载器</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/renderer/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 3: Stub `desktop/src/renderer/main.tsx`**

```tsx
import React from 'react'
import ReactDOM from 'react-dom/client'

const root = document.getElementById('root')!
ReactDOM.createRoot(root).render(<div>scaffold ok</div>)
```

- [ ] **Step 4: Verify Vite dev server starts**

```bash
cd desktop && npm run build:renderer
```

Expected: builds `dist/` without error.

- [ ] **Step 5: Commit**

```bash
git add desktop/vite.config.ts desktop/index.html desktop/src/renderer/main.tsx
git commit -m "chore(desktop): Vite config + index.html + renderer entry stub"
```

---

### Task 2.3: Main process — app lifecycle + window creation

**Files:**
- Create: `desktop/src/main/index.ts`
- Create: `desktop/src/shared/types.ts`

- [ ] **Step 1: `desktop/src/shared/types.ts`** (shared between Main and Renderer)

```ts
export interface SidecarInfo {
  port: number
  pid: number
}

export interface CookiesStatus {
  logged_in: boolean
  sec_uid?: string
}

export interface ExposedApi {
  getSidecarInfo(): Promise<SidecarInfo>
  openLoginWindow(): Promise<void>
  onCookiesChanged(callback: () => void): () => void // unsubscribe
  chooseDirectory(): Promise<string | null>
  getAppVersion(): Promise<string>
}
```

- [ ] **Step 2: `desktop/src/main/index.ts`**

```ts
import { app, BrowserWindow } from 'electron'
import path from 'node:path'
import { startSidecar, stopSidecar, getSidecarInfo } from './sidecar'
import { registerIpc } from './ipc'
import { initAutoUpdate } from './auto-update'

const isDev = !app.isPackaged

let mainWindow: BrowserWindow | null = null

async function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 820,
    minHeight: 580,
    title: '抖音下载器',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  if (isDev) {
    await mainWindow.loadURL('http://127.0.0.1:5173')
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    await mainWindow.loadFile(path.join(__dirname, '..', '..', 'dist', 'index.html'))
  }
}

app.whenReady().then(async () => {
  try {
    await startSidecar()
  } catch (err) {
    const { dialog } = await import('electron')
    dialog.showErrorBox('启动失败', `Python 服务未能启动：${String(err)}`)
    app.quit()
    return
  }
  registerIpc()
  await createMainWindow()
  if (!isDev) initAutoUpdate()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', async () => {
  if (BrowserWindow.getAllWindows().length === 0) await createMainWindow()
})

app.on('before-quit', async () => {
  await stopSidecar()
})

export { getSidecarInfo }
```

- [ ] **Step 3: Commit (this is a partial — sidecar/ipc/auto-update stubs in next tasks)**

We'll commit after Task 2.4 once it compiles.

---

### Task 2.4: Sidecar lifecycle manager

**Files:**
- Create: `desktop/src/main/sidecar.ts`
- Test: `desktop/src/main/__tests__/sidecar.test.ts`

- [ ] **Step 1: Failing test (Vitest)**

```ts
// desktop/src/main/__tests__/sidecar.test.ts
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { parseReadyMarker } from '../sidecar'

describe('parseReadyMarker', () => {
  it('extracts port and pid', () => {
    expect(parseReadyMarker('DOUYIN_SIDECAR_READY port=54321 pid=999')).toEqual({
      port: 54321,
      pid: 999,
    })
  })
  it('returns null for non-marker lines', () => {
    expect(parseReadyMarker('some other log line')).toBeNull()
  })
  it('returns null when port is invalid', () => {
    expect(parseReadyMarker('DOUYIN_SIDECAR_READY port=abc pid=1')).toBeNull()
  })
})
```

- [ ] **Step 2: Implement `desktop/src/main/sidecar.ts`**

```ts
import { app } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import type { SidecarInfo } from '../shared/types'

let child: ChildProcess | null = null
let info: SidecarInfo | null = null
let stderrRing: string[] = []
const STDERR_RING_SIZE = 200

const READY_RE = /^DOUYIN_SIDECAR_READY port=(\d+) pid=(\d+)$/

export function parseReadyMarker(line: string): SidecarInfo | null {
  const m = READY_RE.exec(line)
  if (!m) return null
  const port = Number(m[1])
  const pid = Number(m[2])
  if (!Number.isFinite(port) || port < 1 || port > 65535) return null
  return { port, pid }
}

function sidecarBinaryPath(): string {
  const platform = process.platform  // 'darwin' | 'win32'
  const arch = process.arch          // 'x64' | 'arm64'
  const exe = platform === 'win32' ? 'douyin-dl-sidecar.exe' : 'douyin-dl-sidecar'
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'sidecar', `${platform}-${arch}`, exe)
  }
  return path.join(__dirname, '..', '..', 'resources', 'sidecar', `${platform}-${arch}`, exe)
}

async function runPythonFallback(): Promise<ChildProcess> {
  // Dev fallback: run `python -m cli.main --serve` from repo root
  const repoRoot = path.resolve(__dirname, '..', '..', '..')
  const py = process.env.DOUYIN_PY || 'python'
  return spawn(py, ['-m', 'cli.main', '--serve', '--serve-port', '0'], {
    cwd: repoRoot,
    env: { ...process.env, PYTHONPATH: repoRoot },
  })
}

export async function startSidecar(): Promise<SidecarInfo> {
  if (info) return info

  const bin = sidecarBinaryPath()
  const usePython = process.env.DOUYIN_USE_PY === '1' || (!app.isPackaged && !require('node:fs').existsSync(bin))

  child = usePython
    ? await runPythonFallback()
    : spawn(bin, ['--serve', '--serve-port', '0'], {})

  child.stderr?.on('data', (buf: Buffer) => {
    const lines = buf.toString('utf8').split('\n').filter(Boolean)
    for (const ln of lines) {
      stderrRing.push(ln)
      if (stderrRing.length > STDERR_RING_SIZE) stderrRing.shift()
    }
  })

  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`sidecar did not become ready in 30s; stderr:\n${stderrRing.slice(-10).join('\n')}`)), 30_000)
  })

  const ready = new Promise<SidecarInfo>((resolve, reject) => {
    let buf = ''
    child!.stdout?.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8')
      let idx: number
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).trim()
        buf = buf.slice(idx + 1)
        const parsed = parseReadyMarker(line)
        if (parsed) {
          resolve(parsed)
          return
        }
      }
    })
    child!.on('exit', (code) => reject(new Error(`sidecar exited before ready (code=${code}); stderr:\n${stderrRing.slice(-10).join('\n')}`)))
  })

  info = await Promise.race([ready, timeout])
  return info
}

export async function stopSidecar(): Promise<void> {
  if (!child) return
  const c = child
  child = null
  info = null
  c.removeAllListeners()
  try {
    c.kill('SIGTERM')
    const t = setTimeout(() => c.kill('SIGKILL'), 3000)
    await new Promise<void>((r) => c.once('exit', () => { clearTimeout(t); r() }))
  } catch {
    /* already exited */
  }
}

export function getSidecarInfo(): SidecarInfo {
  if (!info) throw new Error('sidecar not started')
  return info
}
```

- [ ] **Step 3: Run unit test**

```bash
cd desktop && npm test
```

Expected: three tests pass.

- [ ] **Step 4: Typecheck Main**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
cd /Users/crimson/codes/douyin/douyin-downloader
git add desktop/src/main/index.ts desktop/src/main/sidecar.ts desktop/src/main/__tests__ desktop/src/shared/types.ts
git commit -m "feat(desktop): Main entry + sidecar lifecycle with stdout marker parsing"
```

---

### Task 2.5: Login window + cookie capture

**Files:**
- Create: `desktop/src/main/login-window.ts`
- Test: `desktop/src/main/__tests__/login-window.test.ts`

- [ ] **Step 1: Failing test for cookie merge logic**

```ts
// desktop/src/main/__tests__/login-window.test.ts
import { describe, expect, it } from 'vitest'
import { mergeCookieArrays, hasRequiredCookies } from '../login-window'

describe('mergeCookieArrays', () => {
  it('unions and prefers the entry with later expirationDate', () => {
    const a = [{ name: 'x', value: 'a', expirationDate: 100 }]
    const b = [{ name: 'x', value: 'b', expirationDate: 200 }]
    expect(mergeCookieArrays(a, b)).toEqual({ x: 'b' })
  })
  it('keeps entries from one side when other is empty', () => {
    expect(mergeCookieArrays([{ name: 'x', value: '1' }], [])).toEqual({ x: '1' })
  })
})

describe('hasRequiredCookies', () => {
  it('needs sessionid_ss, ttwid, passport_csrf_token', () => {
    expect(hasRequiredCookies({ sessionid_ss: 'a', ttwid: 'b', passport_csrf_token: 'c' })).toBe(true)
    expect(hasRequiredCookies({ sessionid_ss: 'a', ttwid: 'b' })).toBe(false)
  })
  it('rejects empty-string values', () => {
    expect(hasRequiredCookies({ sessionid_ss: '', ttwid: 'b', passport_csrf_token: 'c' })).toBe(false)
  })
})
```

- [ ] **Step 2: Implement `desktop/src/main/login-window.ts`**

```ts
import { BrowserWindow, session, app } from 'electron'
import { getSidecarInfo } from './sidecar'

const DOUYIN_URL = 'https://www.douyin.com/'
const REQUIRED = ['sessionid_ss', 'ttwid', 'passport_csrf_token'] as const
const PARTITION = 'persist:douyin-login'

type ECookie = {
  name: string
  value: string
  domain?: string
  expirationDate?: number
}

export function mergeCookieArrays(...arrs: ECookie[][]): Record<string, string> {
  const best = new Map<string, ECookie>()
  for (const arr of arrs) {
    for (const c of arr) {
      const prev = best.get(c.name)
      if (!prev || (c.expirationDate ?? 0) >= (prev.expirationDate ?? 0)) {
        best.set(c.name, c)
      }
    }
  }
  const out: Record<string, string> = {}
  for (const [k, v] of best) out[k] = v.value
  return out
}

export function hasRequiredCookies(cookies: Record<string, string>): boolean {
  return REQUIRED.every((k) => !!cookies[k])
}

async function collectCookies(sess: Electron.Session): Promise<Record<string, string>> {
  const [a, b, c] = await Promise.all([
    sess.cookies.get({ domain: '.douyin.com' }),
    sess.cookies.get({ domain: '.iesdouyin.com' }),
    sess.cookies.get({ domain: 'www.douyin.com' }),
  ])
  return mergeCookieArrays(a as any, b as any, c as any)
}

async function postCookiesToSidecar(cookies: Record<string, string>): Promise<void> {
  const { port } = getSidecarInfo()
  const r = await fetch(`http://127.0.0.1:${port}/api/v1/cookies`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cookies }),
  })
  if (!r.ok) throw new Error(`POST /cookies failed: ${r.status}`)
}

export async function openLoginWindow(parent: BrowserWindow | undefined, onCookiesReady: () => void): Promise<void> {
  const sess = session.fromPartition(PARTITION)
  const win = new BrowserWindow({
    width: 480,
    height: 720,
    parent,
    modal: false,
    title: '登录抖音',
    webPreferences: {
      partition: PARTITION,
      nodeIntegration: false,
      contextIsolation: true,
    },
  })
  await win.loadURL(DOUYIN_URL)

  let captured = false
  const listener = async () => {
    if (captured) return
    const cookies = await collectCookies(sess)
    if (!hasRequiredCookies(cookies)) return
    captured = true
    try {
      await postCookiesToSidecar(cookies)
      onCookiesReady()
    } catch (err) {
      console.error('post cookies failed', err)
    }
    win.close()
  }
  sess.cookies.on('changed', listener)

  win.on('closed', () => {
    try { sess.cookies.off('changed', listener as any) } catch {}
  })
}
```

- [ ] **Step 3: Run tests; expect PASS**

```bash
cd desktop && npm test
```

- [ ] **Step 4: Commit**

```bash
cd /Users/crimson/codes/douyin/douyin-downloader
git add desktop/src/main/login-window.ts desktop/src/main/__tests__/login-window.test.ts
git commit -m "feat(desktop): embedded Douyin login window with cookie capture"
```

---

### Task 2.6: IPC surface + preload bridge + auto-update stub

**Files:**
- Create: `desktop/src/main/ipc.ts`
- Create: `desktop/src/main/auto-update.ts`
- Create: `desktop/src/preload/index.ts`

- [ ] **Step 1: `desktop/src/main/ipc.ts`**

```ts
import { app, BrowserWindow, ipcMain, dialog } from 'electron'
import { getSidecarInfo } from './sidecar'
import { openLoginWindow } from './login-window'

export function registerIpc(): void {
  ipcMain.handle('sidecar:info', () => getSidecarInfo())

  ipcMain.handle('login:open', async (event) => {
    const parent = BrowserWindow.fromWebContents(event.sender) ?? undefined
    await new Promise<void>((resolve) => {
      openLoginWindow(parent, () => {
        event.sender.send('cookies:changed')
        resolve()
      }).catch((err) => {
        console.error(err)
        resolve()
      })
    })
  })

  ipcMain.handle('dialog:choose-directory', async (event) => {
    const parent = BrowserWindow.fromWebContents(event.sender) ?? undefined
    const res = await dialog.showOpenDialog(parent!, { properties: ['openDirectory', 'createDirectory'] })
    if (res.canceled || res.filePaths.length === 0) return null
    return res.filePaths[0]
  })

  ipcMain.handle('app:version', () => app.getVersion())
}
```

- [ ] **Step 2: `desktop/src/main/auto-update.ts`**

```ts
import { app } from 'electron'

export function initAutoUpdate(): void {
  // Lazy-load to avoid pulling electron-updater into dev hot path
  import('electron-updater').then(({ autoUpdater }) => {
    autoUpdater.autoDownload = true
    autoUpdater.on('error', (e) => console.error('autoUpdate error', e))
    autoUpdater.checkForUpdatesAndNotify().catch((e) => console.warn('update check failed', e))
  }).catch((e) => console.warn('autoUpdate import failed', e))
}
```

- [ ] **Step 3: `desktop/src/preload/index.ts`**

```ts
import { contextBridge, ipcRenderer } from 'electron'
import type { ExposedApi, SidecarInfo } from '../shared/types'

const api: ExposedApi = {
  getSidecarInfo: () => ipcRenderer.invoke('sidecar:info') as Promise<SidecarInfo>,
  openLoginWindow: () => ipcRenderer.invoke('login:open'),
  onCookiesChanged: (cb) => {
    const handler = () => cb()
    ipcRenderer.on('cookies:changed', handler)
    return () => ipcRenderer.off('cookies:changed', handler)
  },
  chooseDirectory: () => ipcRenderer.invoke('dialog:choose-directory') as Promise<string | null>,
  getAppVersion: () => ipcRenderer.invoke('app:version') as Promise<string>,
}

contextBridge.exposeInMainWorld('api', api)

// Type declaration for Renderer
declare global {
  interface Window {
    api: ExposedApi
  }
}
```

- [ ] **Step 4: Typecheck**

```bash
cd desktop && npm run typecheck
```

- [ ] **Step 5: Build Main**

```bash
npm run build:main
```

Expected: `dist-electron/main/index.js`, `dist-electron/preload/index.js` produced.

- [ ] **Step 6: Commit**

```bash
cd /Users/crimson/codes/douyin/douyin-downloader
git add desktop/src/main/ipc.ts desktop/src/main/auto-update.ts desktop/src/preload/index.ts
git commit -m "feat(desktop): IPC surface, preload bridge, auto-update stub"
```

---

### Task 2.7: Dev run script

**Files:**
- Create: `desktop/scripts/dev-run.mjs`

- [ ] **Step 1: `desktop/scripts/dev-run.mjs`**

```js
#!/usr/bin/env node
// Spawn Vite dev server + build Main + launch Electron, wired together.
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const desktopDir = path.resolve(here, '..')

function run(cmd, args, opts = {}) {
  const c = spawn(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32', cwd: desktopDir, ...opts })
  c.on('exit', (code) => { if (code) process.exit(code) })
  return c
}

const vite = run('npx', ['vite'])

// Wait until Vite is serving (strictPort: 5173 configured)
await new Promise((r) => setTimeout(r, 1500))

run('npx', ['tsc', '-p', 'tsconfig.node.json', '--watch'], { stdio: 'inherit' })

// Launch Electron after a short delay so build:main has first output
await new Promise((r) => setTimeout(r, 2500))
run('npx', ['electron', '.'])

process.on('SIGINT', () => {
  vite.kill()
  process.exit(0)
})
```

- [ ] **Step 2: Commit**

```bash
git add desktop/scripts/dev-run.mjs
git commit -m "chore(desktop): dev-run script orchestrating Vite + tsc watch + Electron"
```

---

## Phase 3 — Renderer Feature Implementation

### Task 3.1: Tailwind + base layout + routing

**Files:**
- Modify: `desktop/package.json` (add tailwind deps)
- Create: `desktop/tailwind.config.js`
- Create: `desktop/postcss.config.js`
- Create: `desktop/src/renderer/styles.css`
- Modify: `desktop/src/renderer/main.tsx`
- Create: `desktop/src/renderer/App.tsx`
- Create: `desktop/src/renderer/pages/Home.tsx`
- Create: `desktop/src/renderer/pages/Batch.tsx`
- Create: `desktop/src/renderer/pages/History.tsx`
- Create: `desktop/src/renderer/pages/Settings.tsx`
- Create: `desktop/src/renderer/components/Sidebar.tsx`

- [ ] **Step 1: Add Tailwind deps**

```bash
cd desktop && npm install -D tailwindcss postcss autoprefixer
npx tailwindcss init -p
```

- [ ] **Step 2: `desktop/tailwind.config.js`**

```js
/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/renderer/**/*.{ts,tsx}'],
  theme: { extend: {} },
  plugins: [],
}
```

- [ ] **Step 3: `desktop/src/renderer/styles.css`**

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

html, body, #root { height: 100%; margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
```

- [ ] **Step 4: `desktop/src/renderer/main.tsx`**

```tsx
import React from 'react'
import ReactDOM from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import App from './App'
import './styles.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </React.StrictMode>,
)
```

- [ ] **Step 5: `desktop/src/renderer/App.tsx`**

```tsx
import { Routes, Route, Navigate } from 'react-router-dom'
import Sidebar from './components/Sidebar'
import Home from './pages/Home'
import Batch from './pages/Batch'
import History from './pages/History'
import Settings from './pages/Settings'

export default function App() {
  return (
    <div className="flex h-full w-full bg-slate-50">
      <Sidebar />
      <main className="flex-1 overflow-auto p-6">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/batch" element={<Batch />} />
          <Route path="/history" element={<History />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<Navigate to="/" />} />
        </Routes>
      </main>
    </div>
  )
}
```

- [ ] **Step 6: `desktop/src/renderer/components/Sidebar.tsx`**

```tsx
import { NavLink } from 'react-router-dom'

const items = [
  { to: '/', label: '下载' },
  { to: '/batch', label: '批量' },
  { to: '/history', label: '历史' },
  { to: '/settings', label: '设置' },
]

export default function Sidebar() {
  return (
    <nav className="w-44 flex-shrink-0 border-r border-slate-200 bg-white">
      <div className="px-4 py-4 text-lg font-semibold">抖音下载器</div>
      <ul className="space-y-1 px-2">
        {items.map((it) => (
          <li key={it.to}>
            <NavLink
              to={it.to}
              className={({ isActive }) =>
                'block rounded-md px-3 py-2 text-sm ' +
                (isActive ? 'bg-slate-900 text-white' : 'text-slate-700 hover:bg-slate-100')
              }
              end={it.to === '/'}
            >
              {it.label}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  )
}
```

- [ ] **Step 7: Stub page components** (all four look like this with different content)

```tsx
// desktop/src/renderer/pages/Home.tsx
export default function Home() {
  return <div><h1 className="text-2xl font-semibold">下载</h1></div>
}
// Batch.tsx, History.tsx, Settings.tsx: analogous stubs
```

- [ ] **Step 8: Build**

```bash
cd desktop && npm run build:renderer
```

- [ ] **Step 9: Commit**

```bash
cd /Users/crimson/codes/douyin/douyin-downloader
git add desktop/tailwind.config.js desktop/postcss.config.js desktop/src/renderer/styles.css desktop/src/renderer/main.tsx desktop/src/renderer/App.tsx desktop/src/renderer/components/Sidebar.tsx desktop/src/renderer/pages/*.tsx desktop/package.json desktop/package-lock.json
git commit -m "feat(desktop): Tailwind + routing + empty page shells"
```

---

### Task 3.2: API client + SSE helper + Zustand store

**Files:**
- Create: `desktop/src/renderer/api/client.ts`
- Create: `desktop/src/renderer/api/sse.ts`
- Create: `desktop/src/renderer/store/index.ts`

- [ ] **Step 1: `desktop/src/renderer/api/client.ts`**

```ts
let baseUrl: string | null = null

export async function getBaseUrl(): Promise<string> {
  if (baseUrl) return baseUrl
  const info = await window.api.getSidecarInfo()
  baseUrl = `http://127.0.0.1:${info.port}`
  return baseUrl
}

async function request<T>(pathname: string, init?: RequestInit): Promise<T> {
  const base = await getBaseUrl()
  const r = await fetch(`${base}${pathname}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
  })
  if (!r.ok) throw new Error(`${init?.method ?? 'GET'} ${pathname} → ${r.status}: ${await r.text()}`)
  return (await r.json()) as T
}

export interface JobResponse { job_id: string; status: string; url: string }
export interface JobDetail { job_id: string; status: string; url: string; total: number; success: number; failed: number; skipped: number; error: string | null }
export interface CookiesStatus { logged_in: boolean; sec_uid?: string }
export interface SettingsShape { path: string; thread: number; rate_limit: number }
export interface HistoryItem {
  aweme_id: string; author_id: string; author_name: string; description: string;
  create_time: number; url_type: string; save_path: string; download_time: string;
}
export interface HistoryPage { total: number; page: number; size: number; items: HistoryItem[] }

export interface DownloadRequestBody {
  url: string
  mode?: Array<'post' | 'like' | 'mix' | 'music'>
  start_time?: string
  end_time?: string
  number?: { post?: number; like?: number; mix?: number; music?: number }
  increment?: boolean
  output_dir?: string
}

export const api = {
  health: () => request<{ status: string }>('/api/v1/health'),
  cookiesStatus: () => request<CookiesStatus>('/api/v1/cookies/status'),
  submitDownload: (body: DownloadRequestBody) =>
    request<JobResponse>('/api/v1/download', { method: 'POST', body: JSON.stringify(body) }),
  getJob: (id: string) => request<JobDetail>(`/api/v1/jobs/${id}`),
  cancelJob: (id: string) => request<{ ok: boolean }>(`/api/v1/jobs/${id}/cancel`, { method: 'POST' }),
  getSettings: () => request<SettingsShape>('/api/v1/settings'),
  patchSettings: (patch: Partial<SettingsShape>) =>
    request<SettingsShape>('/api/v1/settings', { method: 'POST', body: JSON.stringify(patch) }),
  history: (params: { page?: number; size?: number; author?: string; url_type?: string }) => {
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.set(k, String(v))
    return request<HistoryPage>(`/api/v1/history?${qs.toString()}`)
  },
}
```

- [ ] **Step 2: `desktop/src/renderer/api/sse.ts`**

```ts
import { getBaseUrl } from './client'

export type JobEvent =
  | { event: 'job-start'; data: { url: string; url_type: string; total: number | null } }
  | { event: 'item-start'; data: { aweme_id: string; index: number; total: number; title: string } }
  | { event: 'item-progress'; data: { aweme_id: string; bytes_read: number; bytes_total: number } }
  | { event: 'item-complete'; data: { aweme_id: string; status: 'ok' | 'failed' | 'skipped'; file_paths: string[] } }
  | { event: 'log'; data: { level: string; message: string; type?: string } }
  | { event: 'done'; data: { total: number; success: number; failed: number; skipped: number } }
  | { event: 'error'; data: { message: string; fatal: boolean } }

export async function subscribeJobEvents(jobId: string, onEvent: (e: JobEvent) => void): Promise<() => void> {
  const base = await getBaseUrl()
  const es = new EventSource(`${base}/api/v1/jobs/${jobId}/events`)
  const eventNames: JobEvent['event'][] = ['job-start', 'item-start', 'item-progress', 'item-complete', 'log', 'done', 'error']
  for (const name of eventNames) {
    es.addEventListener(name, (msg) => {
      try {
        const parsed = JSON.parse((msg as MessageEvent).data)
        onEvent({ event: name, data: parsed } as JobEvent)
      } catch {
        // malformed event payload — drop
      }
    })
  }
  return () => es.close()
}
```

- [ ] **Step 3: `desktop/src/renderer/store/index.ts`**

```ts
import { create } from 'zustand'

interface AppState {
  loggedIn: boolean
  setLoggedIn: (v: boolean) => void
  activeJobId: string | null
  setActiveJobId: (id: string | null) => void
}

export const useAppStore = create<AppState>((set) => ({
  loggedIn: false,
  setLoggedIn: (v) => set({ loggedIn: v }),
  activeJobId: null,
  setActiveJobId: (id) => set({ activeJobId: id }),
}))
```

- [ ] **Step 4: Build & typecheck**

```bash
cd desktop && npm run typecheck && npm run build:renderer
```

- [ ] **Step 5: Commit**

```bash
cd /Users/crimson/codes/douyin/douyin-downloader
git add desktop/src/renderer/api desktop/src/renderer/store
git commit -m "feat(desktop): API client, SSE helper, Zustand store"
```

---

### Task 3.3: Home page — URL input + progress + login banner

**Files:**
- Modify: `desktop/src/renderer/pages/Home.tsx`
- Create: `desktop/src/renderer/components/LoginBanner.tsx`
- Create: `desktop/src/renderer/components/JobProgress.tsx`

- [ ] **Step 1: `desktop/src/renderer/components/LoginBanner.tsx`**

```tsx
import { useEffect } from 'react'
import { api } from '../api/client'
import { useAppStore } from '../store'

export default function LoginBanner() {
  const { loggedIn, setLoggedIn } = useAppStore()

  useEffect(() => {
    api.cookiesStatus().then((s) => setLoggedIn(s.logged_in)).catch(() => {})
    const unsub = window.api.onCookiesChanged(async () => {
      const s = await api.cookiesStatus()
      setLoggedIn(s.logged_in)
    })
    return () => unsub()
  }, [setLoggedIn])

  if (loggedIn) return null
  return (
    <div className="mb-4 flex items-center justify-between rounded-md border border-amber-300 bg-amber-50 px-4 py-3">
      <div className="text-sm text-amber-900">尚未登录抖音，部分功能（如用户批量下载）需要登录后才能使用。</div>
      <button
        className="rounded-md bg-amber-600 px-3 py-1 text-sm text-white hover:bg-amber-700"
        onClick={() => window.api.openLoginWindow()}
      >
        登录
      </button>
    </div>
  )
}
```

- [ ] **Step 2: `desktop/src/renderer/components/JobProgress.tsx`**

```tsx
import { useEffect, useState } from 'react'
import { api } from '../api/client'
import { subscribeJobEvents, type JobEvent } from '../api/sse'

interface Props { jobId: string; onDone?: () => void }

export default function JobProgress({ jobId, onDone }: Props) {
  const [events, setEvents] = useState<JobEvent[]>([])
  const [totals, setTotals] = useState<{ total: number; success: number; failed: number; skipped: number } | null>(null)

  useEffect(() => {
    let unsub: (() => void) | null = null
    subscribeJobEvents(jobId, (e) => {
      setEvents((prev) => [...prev.slice(-199), e])
      if (e.event === 'done') { setTotals(e.data); onDone?.() }
    }).then((u) => { unsub = u })
    return () => { unsub?.() }
  }, [jobId, onDone])

  const lastProgress = [...events].reverse().find((e) => e.event === 'item-progress') as Extract<JobEvent, { event: 'item-progress' }> | undefined
  const pct = lastProgress && lastProgress.data.bytes_total
    ? Math.min(100, Math.round((lastProgress.data.bytes_read / lastProgress.data.bytes_total) * 100))
    : 0

  return (
    <div className="rounded-md border border-slate-200 bg-white p-4">
      <div className="flex items-center justify-between">
        <div className="text-sm text-slate-600">Job <code className="text-xs">{jobId}</code></div>
        <button className="text-xs text-slate-500 hover:text-red-600" onClick={() => api.cancelJob(jobId)}>取消</button>
      </div>
      {totals ? (
        <div className="mt-2 text-sm">完成：{totals.success}/{totals.total}（失败 {totals.failed}，跳过 {totals.skipped}）</div>
      ) : (
        <div className="mt-2">
          <div className="h-2 w-full overflow-hidden rounded bg-slate-100">
            <div className="h-full bg-emerald-500 transition-all" style={{ width: `${pct}%` }} />
          </div>
          <div className="mt-1 text-xs text-slate-500">{pct}%</div>
        </div>
      )}
      <div className="mt-3 max-h-40 overflow-auto font-mono text-[11px] text-slate-500">
        {events.slice(-20).map((e, i) => <div key={i}>{e.event}: {JSON.stringify(e.data).slice(0, 120)}</div>)}
      </div>
    </div>
  )
}
```

- [ ] **Step 3: `desktop/src/renderer/pages/Home.tsx`**

```tsx
import { useState } from 'react'
import { api } from '../api/client'
import LoginBanner from '../components/LoginBanner'
import JobProgress from '../components/JobProgress'

export default function Home() {
  const [url, setUrl] = useState('')
  const [jobId, setJobId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    setError(null)
    try {
      const res = await api.submitDownload({ url: url.trim() })
      setJobId(res.job_id)
    } catch (err) {
      setError(String(err))
    }
  }

  return (
    <div>
      <h1 className="mb-4 text-2xl font-semibold">下载</h1>
      <LoginBanner />
      <div className="mb-4 flex gap-2">
        <input
          className="flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-900 focus:outline-none"
          placeholder="粘贴抖音链接（短链、视频、图文、合集都支持）"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        <button
          className="rounded-md bg-slate-900 px-4 py-2 text-sm text-white hover:bg-slate-800 disabled:opacity-50"
          onClick={submit}
          disabled={!url.trim()}
        >
          下载
        </button>
      </div>
      {error && <div className="mb-4 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
      {jobId && <JobProgress jobId={jobId} />}
    </div>
  )
}
```

- [ ] **Step 4: Build**

```bash
cd desktop && npm run typecheck && npm run build:renderer
```

- [ ] **Step 5: Commit**

```bash
cd /Users/crimson/codes/douyin/douyin-downloader
git add desktop/src/renderer/pages/Home.tsx desktop/src/renderer/components/LoginBanner.tsx desktop/src/renderer/components/JobProgress.tsx
git commit -m "feat(desktop): Home page — URL submit, login banner, live progress via SSE"
```

---

### Task 3.4: Batch page — profile mode + filters

**Files:**
- Modify: `desktop/src/renderer/pages/Batch.tsx`

- [ ] **Step 1: Implement Batch.tsx**

```tsx
import { useState } from 'react'
import { api, type DownloadRequestBody } from '../api/client'
import JobProgress from '../components/JobProgress'

const MODES: Array<'post' | 'like' | 'mix' | 'music'> = ['post', 'like', 'mix', 'music']
const MODE_LABEL: Record<string, string> = { post: '作品', like: '喜欢', mix: '合集', music: '音乐' }

export default function Batch() {
  const [url, setUrl] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set(['post']))
  const [startTime, setStartTime] = useState('')
  const [endTime, setEndTime] = useState('')
  const [count, setCount] = useState('')
  const [increment, setIncrement] = useState(true)
  const [jobId, setJobId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  function toggle(m: string) {
    const next = new Set(selected)
    if (next.has(m)) next.delete(m)
    else next.add(m)
    setSelected(next)
  }

  async function submit() {
    setError(null)
    const body: DownloadRequestBody = {
      url: url.trim(),
      mode: Array.from(selected) as DownloadRequestBody['mode'],
      increment,
    }
    if (startTime) body.start_time = startTime
    if (endTime) body.end_time = endTime
    const n = Number(count)
    if (Number.isFinite(n) && n > 0) body.number = { post: n, like: n, mix: n, music: n }
    try {
      const res = await api.submitDownload(body)
      setJobId(res.job_id)
    } catch (err) {
      setError(String(err))
    }
  }

  return (
    <div>
      <h1 className="mb-4 text-2xl font-semibold">批量下载</h1>
      <div className="space-y-3 rounded-md border border-slate-200 bg-white p-4">
        <label className="block text-sm">
          <span className="mb-1 block text-slate-700">用户主页链接</span>
          <input
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            placeholder="https://www.douyin.com/user/..."
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        </label>

        <div>
          <div className="mb-1 text-sm text-slate-700">下载模式</div>
          <div className="flex gap-3">
            {MODES.map((m) => (
              <label key={m} className="flex items-center gap-1 text-sm">
                <input type="checkbox" checked={selected.has(m)} onChange={() => toggle(m)} /> {MODE_LABEL[m]}
              </label>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <label className="block text-sm">
            <span className="mb-1 block text-slate-700">起始日期</span>
            <input type="date" className="w-full rounded-md border border-slate-300 px-2 py-1 text-sm" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-slate-700">结束日期</span>
            <input type="date" className="w-full rounded-md border border-slate-300 px-2 py-1 text-sm" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-slate-700">数量上限</span>
            <input type="number" min={0} className="w-full rounded-md border border-slate-300 px-2 py-1 text-sm" value={count} onChange={(e) => setCount(e.target.value)} placeholder="不填=全部" />
          </label>
        </div>

        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={increment} onChange={(e) => setIncrement(e.target.checked)} />
          增量下载（跳过已下载作品）
        </label>

        <div className="flex justify-end">
          <button
            className="rounded-md bg-slate-900 px-4 py-2 text-sm text-white hover:bg-slate-800 disabled:opacity-50"
            disabled={!url.trim() || selected.size === 0}
            onClick={submit}
          >
            开始批量下载
          </button>
        </div>
      </div>

      {error && <div className="mt-4 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
      {jobId && <div className="mt-4"><JobProgress jobId={jobId} /></div>}
    </div>
  )
}
```

- [ ] **Step 2: Build + commit**

```bash
cd desktop && npm run typecheck && npm run build:renderer
cd /Users/crimson/codes/douyin/douyin-downloader
git add desktop/src/renderer/pages/Batch.tsx
git commit -m "feat(desktop): Batch page with mode checkboxes + date/count filters"
```

---

### Task 3.5: History page

**Files:**
- Modify: `desktop/src/renderer/pages/History.tsx`

- [ ] **Step 1: Implement History.tsx**

```tsx
import { useEffect, useState } from 'react'
import { api, type HistoryItem } from '../api/client'

export default function History() {
  const [items, setItems] = useState<HistoryItem[]>([])
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [author, setAuthor] = useState('')
  const [urlType, setUrlType] = useState('')
  const size = 20

  async function load() {
    const res = await api.history({ page, size, author: author.trim() || undefined, url_type: urlType || undefined })
    setItems(res.items)
    setTotal(res.total)
  }

  useEffect(() => { load().catch(console.error) }, [page, author, urlType]) // eslint-disable-line react-hooks/exhaustive-deps

  const pages = Math.max(1, Math.ceil(total / size))

  return (
    <div>
      <h1 className="mb-4 text-2xl font-semibold">历史</h1>
      <div className="mb-3 flex gap-2">
        <input placeholder="按作者筛选" className="rounded-md border border-slate-300 px-3 py-1 text-sm" value={author} onChange={(e) => { setPage(1); setAuthor(e.target.value) }} />
        <select className="rounded-md border border-slate-300 px-2 py-1 text-sm" value={urlType} onChange={(e) => { setPage(1); setUrlType(e.target.value) }}>
          <option value="">全部类型</option>
          <option value="video">视频</option>
          <option value="note">图文</option>
          <option value="mix">合集</option>
          <option value="music">音乐</option>
        </select>
      </div>
      <div className="overflow-hidden rounded-md border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs text-slate-600">
            <tr><th className="p-2">作者</th><th className="p-2">描述</th><th className="p-2">类型</th><th className="p-2">发布时间</th><th className="p-2">路径</th></tr>
          </thead>
          <tbody>
            {items.map((it) => (
              <tr key={it.aweme_id} className="border-t border-slate-100">
                <td className="p-2">{it.author_name}</td>
                <td className="p-2 max-w-[320px] truncate">{it.description || '—'}</td>
                <td className="p-2">{it.url_type}</td>
                <td className="p-2">{it.create_time ? new Date(it.create_time * 1000).toLocaleDateString() : '—'}</td>
                <td className="p-2 max-w-[260px] truncate text-xs text-slate-500">{it.save_path}</td>
              </tr>
            ))}
            {items.length === 0 && <tr><td colSpan={5} className="p-8 text-center text-slate-400">暂无记录</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="mt-3 flex items-center justify-between text-sm text-slate-500">
        <div>共 {total} 条</div>
        <div className="flex gap-2">
          <button className="rounded-md border px-2 py-0.5 disabled:opacity-40" disabled={page <= 1} onClick={() => setPage(page - 1)}>上一页</button>
          <div>{page} / {pages}</div>
          <button className="rounded-md border px-2 py-0.5 disabled:opacity-40" disabled={page >= pages} onClick={() => setPage(page + 1)}>下一页</button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Build + commit**

```bash
cd desktop && npm run typecheck && npm run build:renderer
cd /Users/crimson/codes/douyin/douyin-downloader
git add desktop/src/renderer/pages/History.tsx
git commit -m "feat(desktop): History page with filters + pagination"
```

---

### Task 3.6: Settings page

**Files:**
- Modify: `desktop/src/renderer/pages/Settings.tsx`

- [ ] **Step 1: Implement Settings.tsx**

```tsx
import { useEffect, useState } from 'react'
import { api, type SettingsShape } from '../api/client'

export default function Settings() {
  const [s, setS] = useState<SettingsShape | null>(null)
  const [version, setVersion] = useState('')
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  useEffect(() => {
    api.getSettings().then(setS).catch(console.error)
    window.api.getAppVersion().then(setVersion)
  }, [])

  async function pick() {
    const p = await window.api.chooseDirectory()
    if (p && s) setS({ ...s, path: p })
  }

  async function save() {
    if (!s) return
    setSaving(true); setMsg(null)
    try {
      const next = await api.patchSettings({ path: s.path, thread: s.thread, rate_limit: s.rate_limit })
      setS(next); setMsg('已保存')
    } catch (e) {
      setMsg(String(e))
    } finally {
      setSaving(false)
    }
  }

  if (!s) return <div>加载中...</div>
  return (
    <div>
      <h1 className="mb-4 text-2xl font-semibold">设置</h1>
      <div className="max-w-xl space-y-4 rounded-md border border-slate-200 bg-white p-5">
        <label className="block text-sm">
          <span className="mb-1 block text-slate-700">下载保存目录</span>
          <div className="flex gap-2">
            <input className="flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm" value={s.path} onChange={(e) => setS({ ...s, path: e.target.value })} />
            <button className="rounded-md border px-3 py-2 text-sm hover:bg-slate-50" onClick={pick}>选择...</button>
          </div>
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-slate-700">并发下载数</span>
          <input type="number" min={1} max={32} className="w-32 rounded-md border border-slate-300 px-3 py-2 text-sm" value={s.thread} onChange={(e) => setS({ ...s, thread: Number(e.target.value) })} />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-slate-700">速率限制（请求/秒）</span>
          <input type="number" min={0} step="0.5" className="w-32 rounded-md border border-slate-300 px-3 py-2 text-sm" value={s.rate_limit} onChange={(e) => setS({ ...s, rate_limit: Number(e.target.value) })} />
        </label>
        <div className="flex items-center gap-3">
          <button className="rounded-md bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-50" disabled={saving} onClick={save}>{saving ? '保存中…' : '保存'}</button>
          {msg && <span className="text-xs text-slate-500">{msg}</span>}
        </div>
      </div>
      <div className="mt-6 text-xs text-slate-400">版本 v{version || '?'}</div>
    </div>
  )
}
```

- [ ] **Step 2: Build + commit**

```bash
cd desktop && npm run typecheck && npm run build:renderer
cd /Users/crimson/codes/douyin/douyin-downloader
git add desktop/src/renderer/pages/Settings.tsx
git commit -m "feat(desktop): Settings page — path, concurrency, rate limit, version"
```

---

## Phase 4 — Build Pipeline

### Task 4.1: PyInstaller build script

**Files:**
- Create: `desktop/scripts/build-sidecar.sh`

- [ ] **Step 1: `desktop/scripts/build-sidecar.sh`**

```bash
#!/usr/bin/env bash
# Build the Python sidecar into desktop/resources/sidecar/<platform>-<arch>/
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_DIR="$(cd "${HERE}/.." && pwd)"
REPO_ROOT="$(cd "${DESKTOP_DIR}/.." && pwd)"

OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"
case "${OS}" in
  darwin) PLATFORM="darwin" ;;
  mingw*|msys*|cygwin*) PLATFORM="win32" ;;
  linux) PLATFORM="linux" ;;
  *) echo "unsupported OS ${OS}"; exit 1 ;;
esac
case "${ARCH}" in
  arm64|aarch64) ARCH_NORM="arm64" ;;
  x86_64|amd64)  ARCH_NORM="x64"   ;;
  *) echo "unsupported arch ${ARCH}"; exit 1 ;;
esac

OUT_DIR="${DESKTOP_DIR}/resources/sidecar/${PLATFORM}-${ARCH_NORM}"
mkdir -p "${OUT_DIR}"

cd "${REPO_ROOT}"
if ! python -c "import PyInstaller" 2>/dev/null; then
  pip install pyinstaller
fi

# Ensure runtime deps present
pip install -e ".[server]"

pyinstaller \
  --onefile \
  --name "douyin-dl-sidecar" \
  --distpath "${OUT_DIR}" \
  --workpath "${DESKTOP_DIR}/.pyinstaller-build" \
  --specpath "${DESKTOP_DIR}/.pyinstaller-build" \
  --hidden-import=sse_starlette \
  --hidden-import=aiosqlite \
  --hidden-import=aiohttp \
  --collect-submodules=core \
  --collect-submodules=auth \
  --collect-submodules=control \
  --collect-submodules=config \
  --collect-submodules=storage \
  --collect-submodules=utils \
  --collect-submodules=server \
  --exclude-module=playwright \
  --exclude-module=whisper \
  --exclude-module=openai \
  run.py

# Record embedded backend version metadata
python - <<'PY' > "${OUT_DIR}/sidecar-version.json"
import json, pathlib, tomllib
data = tomllib.loads(pathlib.Path("pyproject.toml").read_text())
print(json.dumps({"backend_version": data["project"]["version"]}))
PY

echo "Sidecar built: ${OUT_DIR}/douyin-dl-sidecar"
```

- [ ] **Step 2: Make executable**

```bash
chmod +x desktop/scripts/build-sidecar.sh
```

- [ ] **Step 3: Run locally (macOS, will produce arm64 or x64 depending on host)**

```bash
cd desktop && npm run build:sidecar
```

Expected: `desktop/resources/sidecar/darwin-arm64/douyin-dl-sidecar` exists and runs:
```bash
./desktop/resources/sidecar/darwin-arm64/douyin-dl-sidecar --serve --serve-port 0
# → "DOUYIN_SIDECAR_READY port=... pid=..."
# Ctrl-C to stop.
```

- [ ] **Step 4: Commit**

```bash
cd /Users/crimson/codes/douyin/douyin-downloader
git add desktop/scripts/build-sidecar.sh
git commit -m "chore(desktop): PyInstaller build-sidecar script"
```

---

### Task 4.2: electron-builder config + entitlements + icons

**Files:**
- Create: `desktop/electron-builder.yml`
- Create: `desktop/resources/entitlements.mac.plist`
- Create: `desktop/resources/icon.icns` (placeholder generation)
- Create: `desktop/resources/icon.ico` (placeholder generation)

- [ ] **Step 1: `desktop/electron-builder.yml`**

```yaml
appId: com.jiji262.douyin-downloader
productName: 抖音下载器
copyright: Copyright © 2026 jiji262
asar: true
directories:
  output: dist-installer
  buildResources: resources

files:
  - from: dist
    to: dist
    filter: ["**/*"]
  - from: dist-electron
    to: dist-electron
    filter: ["**/*"]
  - package.json

extraResources:
  - from: resources/sidecar
    to: sidecar
    filter: ["**/*"]

mac:
  category: public.app-category.utilities
  icon: resources/icon.icns
  hardenedRuntime: true
  gatekeeperAssess: false
  entitlements: resources/entitlements.mac.plist
  entitlementsInherit: resources/entitlements.mac.plist
  target:
    - target: dmg
      arch:
        - arm64
        - x64
  notarize: false  # flip to true once APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID env vars are configured

win:
  icon: resources/icon.ico
  target:
    - target: nsis
      arch:
        - x64
  signAndEditExecutable: false  # enable once CSC_LINK is configured

nsis:
  oneClick: false
  perMachine: false
  allowToChangeInstallationDirectory: true

publish:
  provider: github
  owner: jiji262
  repo: douyin-downloader
  releaseType: release
```

- [ ] **Step 2: `desktop/resources/entitlements.mac.plist`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-jit</key>
  <true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
  <true/>
  <key>com.apple.security.network.client</key>
  <true/>
  <key>com.apple.security.files.user-selected.read-write</key>
  <true/>
</dict>
</plist>
```

- [ ] **Step 3: Placeholder icons**

Use existing `img/` asset if any; otherwise generate a minimal PNG→ICNS/ICO
pair. If no icon asset is present, the spec allows shipping without custom
icons for MVP (electron-builder falls back to its default):

```bash
# Skip this task if img/ has no suitable source. electron-builder uses a
# default icon if resources/icon.* is missing. Remove the `icon:` keys from
# electron-builder.yml in that case.
```

- [ ] **Step 4: Commit**

```bash
git add desktop/electron-builder.yml desktop/resources/entitlements.mac.plist
git commit -m "chore(desktop): electron-builder config + macOS entitlements"
```

---

### Task 4.3: End-to-end local build smoke

**Files:** none

- [ ] **Step 1: Full local build**

```bash
cd desktop
npm run build:sidecar
npm run build
npm run dist:mac -- --publish=never
```

Expected: produces `dist-installer/抖音下载器-0.1.0-arm64.dmg`. Install, open,
verify sidecar starts and Home page loads. Document in plan comment that
notarization is off at this stage.

- [ ] **Step 2: Record smoke result in commit log**

Not a commit — evidence captured in the review at Phase 7.

---

## Phase 5 — CI & Release

### Task 5.1: Desktop release workflow

**Files:**
- Create: `.github/workflows/desktop-release.yml`

- [ ] **Step 1: Write workflow**

```yaml
name: desktop-release
on:
  push:
    tags:
      - 'desktop-v*'
  workflow_dispatch:

jobs:
  build:
    strategy:
      fail-fast: false
      matrix:
        include:
          - os: macos-14
            arch: arm64
          - os: macos-13
            arch: x64
          - os: windows-2022
            arch: x64
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-python@v5
        with:
          python-version: '3.11'

      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
          cache-dependency-path: 'desktop/package-lock.json'

      - name: Install Python deps + PyInstaller
        run: |
          python -m pip install --upgrade pip
          pip install -e ".[server]"
          pip install pyinstaller

      - name: Install npm deps
        working-directory: desktop
        run: npm ci

      - name: Build sidecar
        working-directory: desktop
        shell: bash
        run: bash scripts/build-sidecar.sh

      - name: Build renderer + main
        working-directory: desktop
        run: npm run build

      - name: Package (mac)
        if: runner.os == 'macOS'
        working-directory: desktop
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: npx electron-builder --mac --publish=always

      - name: Package (win)
        if: runner.os == 'Windows'
        working-directory: desktop
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: npx electron-builder --win --publish=always

      - name: Upload artifacts
        uses: actions/upload-artifact@v4
        with:
          name: desktop-${{ matrix.os }}-${{ matrix.arch }}
          path: desktop/dist-installer/*
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/desktop-release.yml
git commit -m "ci(desktop): matrix release workflow producing dmg + exe on tag push"
```

---

## Phase 6 — Docs & Polish

### Task 6.1: `desktop/README.md`

**Files:**
- Create: `desktop/README.md`

- [ ] **Step 1: Content**

```markdown
# 抖音下载器桌面版（Electron）

跨平台桌面壳，内嵌 Python 后端，无需用户安装 Python 即可使用。

## 用户安装

### macOS

1. 从 [Releases](https://github.com/jiji262/douyin-downloader/releases) 下载对应架构的 `.dmg`。
2. 双击安装到 Applications。
3. 首次运行（未签名版本）如提示"无法打开"：
   - 终端执行：`xattr -cr /Applications/抖音下载器.app`
   - 或"系统设置 → 隐私与安全 → 仍要打开"

### Windows

1. 下载 `.exe` 安装包。
2. SmartScreen 警告时点击"更多信息 → 仍要运行"。

## 登录

首次启动会提示登录。点击"登录"打开内嵌窗口，照常在抖音网页登录即可，无需手动复制 cookie。

## 开发

### 前置

- Node 20 LTS
- Python 3.11

### 首次安装

```bash
# 根目录
pip install -e ".[server,dev]"

# desktop/
cd desktop
npm install
```

### 启动（两个终端）

```bash
# 终端 1：Python 服务
python -m cli.main --serve --serve-port 8000

# 终端 2：Electron dev
cd desktop
npm run dev
```

Electron 默认连接 `desktop/resources/sidecar/` 下的打包二进制；开发模式下
若该目录为空，会自动 fallback 到 `python -m cli.main --serve` 。

### 生产打包

```bash
cd desktop
npm run build:sidecar   # PyInstaller
npm run build           # tsc + vite
npm run dist:mac        # 或 dist:win
```

产物在 `desktop/dist-installer/`。

## 签名与公证

MVP 默认输出 **未签名** 构建。要出签名版本：

- macOS：购买 Apple Developer ID Application 证书，设置 `APPLE_ID`、
  `APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID` 三个环境变量，把
  `electron-builder.yml` 里的 `mac.notarize` 改成 `true`。
- Windows：购买 Code Signing 证书，设置 `CSC_LINK`（证书路径或 base64）和
  `CSC_KEY_PASSWORD`。

详见 `docs/superpowers/specs/2026-04-24-desktop-app-electron-design.md` § 7。
```

- [ ] **Step 2: Commit**

```bash
git add desktop/README.md
git commit -m "docs(desktop): user install, dev, build, signing guide"
```

---

### Task 6.2: Root README mention + AGENTS.md addendum

**Files:**
- Modify: `README.md`, `README.zh-CN.md`
- Modify: `AGENTS.md`

- [ ] **Step 1: Add a Desktop App section to both READMEs**

Insert near the top of `README.md` (after the intro paragraph):

```markdown
### Desktop App (MVP)

A cross-platform desktop wrapper (macOS / Windows) is under `desktop/`. It
bundles the Python backend as a sidecar so end users don't need to install
Python. See [desktop/README.md](./desktop/README.md).
```

Mirror in `README.zh-CN.md` with the Chinese translation.

- [ ] **Step 2: Append to `AGENTS.md`**

```markdown
## `desktop/` subtree

Contains the Electron desktop wrapper. Rules for agents modifying this tree:

- Zero Python code inside `desktop/`; zero Node/TS outside.
- The sole boundary crossing is `desktop/scripts/build-sidecar.sh` (PyInstaller).
- Python backend stays functional as both a CLI (`python -m cli.main`) and a
  sidecar (`python -m cli.main --serve --serve-port 0`). Don't break either.
- Design spec: `docs/superpowers/specs/2026-04-24-desktop-app-electron-design.md`.
- Implementation plan: `docs/superpowers/plans/2026-04-24-desktop-app.md`.
```

- [ ] **Step 3: Commit**

```bash
git add README.md README.zh-CN.md AGENTS.md
git commit -m "docs: mention desktop app in top-level READMEs + AGENTS.md"
```

---

## Phase 7 — Code Review & Fixes

### Task 7.1: Independent code review

**Files:** none (review-only)

- [ ] **Step 1: Dispatch `superpowers:requesting-code-review` or `/review`**

Prompt template:
> Please review this branch / PR against `docs/superpowers/specs/2026-04-24-desktop-app-electron-design.md`. Focus areas:
> 1. Python server extensions — cookies/SSE/history/cancel/settings endpoints; check for leaks (history DB lifecycle), race conditions (SSE broker + cancel), and CLI regression risk.
> 2. Electron Main — sidecar lifecycle (spawn/kill/restart), stdout marker parsing, cookie capture flow, security (contextIsolation, sandbox).
> 3. Renderer — API client error handling, SSE reconnect behavior, UX edge cases (empty cookie status, cancelled jobs, pagination math).
> 4. Build pipeline — PyInstaller hidden imports, electron-builder file includes, cross-platform assumptions.
> 5. Docs — README overrides documented for unsigned builds.

- [ ] **Step 2: Capture findings in a triage list**

Each finding gets: severity (blocker / important / nit), file+line, suggested fix.

---

### Task 7.2: Triage + fix

- [ ] **Step 1: Blocker findings** — fix inline, create commits per finding.
- [ ] **Step 2: Important findings** — fix if time allows before release.
- [ ] **Step 3: Nits** — fix-or-defer; note in `desktop/README.md` troubleshooting section if user-visible.
- [ ] **Step 4: Run full test suite again**

```bash
PYTHONPATH=. pytest -q
cd desktop && npm test && npm run typecheck && npm run build
```

- [ ] **Step 5: Tag the release (do NOT push unless user approves)**

```bash
git tag -a desktop-v0.1.0-alpha1 -m "First desktop build — unsigned"
# Push only after user explicit green light:
# git push origin desktop-v0.1.0-alpha1
```

---

## Verification Summary (what "done" looks like)

- `PYTHONPATH=. pytest -q` → all green (existing + new tests).
- `cd desktop && npm test` → all green.
- `cd desktop && npm run typecheck` → no errors.
- `cd desktop && npm run build:sidecar && npm run build && npm run dist:mac -- --publish=never`
  → produces a runnable `.dmg` on macOS; installed app launches, sidecar
  starts, Home page renders, cookies status endpoint returns.
- `docs/superpowers/specs/2026-04-24-desktop-app-electron-design.md` §13
  "Blocked on user" items remain open (certs, real Windows smoke).
- Git log is linear with one commit per task; no force-push.
