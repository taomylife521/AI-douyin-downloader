import asyncio
import pytest
from httpx import ASGITransport, AsyncClient

from config import ConfigLoader
from server.jobs import DownloadJob, JobManager, JobStatus


async def _build_test_app(tmp_path):
    from server.app import build_app
    config = ConfigLoader(None)
    config.update(path=str(tmp_path), cookies={})
    app = build_app(config)
    return app


@pytest.mark.asyncio
async def test_job_has_event_queue():
    job = DownloadJob(job_id="x", url="https://v.douyin.com/abc")
    assert hasattr(job, "events")
    assert isinstance(job.events, asyncio.Queue)


@pytest.mark.asyncio
async def test_submit_creates_job_with_events():
    async def fake_exec(url, reporter=None, overrides=None):
        if reporter is not None:
            reporter.on_job_done(total=1, success=1, failed=0, skipped=0)
        return {"total": 1, "success": 1, "failed": 0, "skipped": 0}

    mgr = JobManager(executor=fake_exec, max_concurrency=1)
    job = await mgr.submit(url="https://v.douyin.com/abc")
    # Wait for the task to finish
    assert job._task is not None
    await job._task
    # Drain queue
    events = []
    while not job.events.empty():
        events.append(job.events.get_nowait())
    assert any(e["event"] == "done" for e in events)


@pytest.mark.asyncio
async def test_cancel_transitions_job_to_cancelled():
    started = asyncio.Event()
    release = asyncio.Event()

    async def slow_exec(url, reporter=None, overrides=None):
        started.set()
        await release.wait()
        return {"total": 0, "success": 0, "failed": 0, "skipped": 0}

    mgr = JobManager(executor=slow_exec, max_concurrency=1)
    job = await mgr.submit(url="https://x")
    await started.wait()
    ok = await mgr.cancel(job.job_id)
    assert ok is True
    # Let the cancellation propagate; await task completion
    assert job._task is not None
    try:
        await job._task
    except asyncio.CancelledError:
        pass
    job2 = await mgr.get(job.job_id)
    assert job2 is not None
    assert job2.status == JobStatus.CANCELLED


@pytest.mark.asyncio
async def test_cancel_returns_false_for_terminal_job():
    async def fake_exec(url, reporter=None, overrides=None):
        return {"total": 0, "success": 0, "failed": 0, "skipped": 0}

    mgr = JobManager(executor=fake_exec, max_concurrency=1)
    job = await mgr.submit(url="https://x")
    assert job._task is not None
    await job._task
    assert (await mgr.cancel(job.job_id)) is False


@pytest.mark.asyncio
async def test_overrides_passed_to_executor():
    captured: dict = {}

    async def recording_exec(url, reporter=None, overrides=None):
        captured["url"] = url
        captured["overrides"] = overrides
        return {"total": 0, "success": 0, "failed": 0, "skipped": 0}

    mgr = JobManager(executor=recording_exec, max_concurrency=1)
    job = await mgr.submit(url="https://x", overrides={"thread": 7, "path": "/tmp"})
    assert job._task is not None
    await job._task
    assert captured["url"] == "https://x"
    assert captured["overrides"] == {"thread": 7, "path": "/tmp"}


@pytest.mark.asyncio
async def test_legacy_executor_without_kwargs_still_works():
    async def legacy_exec(url):
        return {"total": 2, "success": 2, "failed": 0, "skipped": 0}

    mgr = JobManager(executor=legacy_exec, max_concurrency=1)
    job = await mgr.submit(url="https://x")
    assert job._task is not None
    await job._task
    job2 = await mgr.get(job.job_id)
    assert job2 is not None
    assert job2.status == JobStatus.SUCCESS
    assert job2.total == 2


# ------------------------- HTTP endpoint tests -------------------------


@pytest.mark.asyncio
async def test_health(tmp_path):
    app = await _build_test_app(tmp_path)
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://t"
    ) as c:
        r = await c.get("/api/v1/health")
        assert r.status_code == 200
        assert r.json()["status"] == "ok"


@pytest.mark.asyncio
async def test_cookies_status_logged_out_initially(tmp_path):
    app = await _build_test_app(tmp_path)
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://t"
    ) as c:
        r = await c.get("/api/v1/cookies/status")
        assert r.status_code == 200
        assert r.json()["logged_in"] is False


@pytest.mark.asyncio
async def test_set_cookies_flips_status(tmp_path, monkeypatch):
    # Keep cookie file writes confined to tmp_path
    monkeypatch.chdir(tmp_path)
    app = await _build_test_app(tmp_path)
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://t"
    ) as c:
        r = await c.post(
            "/api/v1/cookies",
            json={
                "cookies": {
                    "sessionid_ss": "aaa",
                    "ttwid": "bbb",
                    "passport_csrf_token": "ccc",
                }
            },
        )
        assert r.status_code == 200
        assert r.json()["ok"] is True

        s = await c.get("/api/v1/cookies/status")
        assert s.status_code == 200
        assert s.json()["logged_in"] is True


@pytest.mark.asyncio
async def test_history_empty(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    app = await _build_test_app(tmp_path)
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://t"
    ) as c:
        r = await c.get("/api/v1/history")
        assert r.status_code == 200
        body = r.json()
        assert body["total"] == 0
        assert body["items"] == []


@pytest.mark.asyncio
async def test_settings_roundtrip(tmp_path):
    app = await _build_test_app(tmp_path)
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://t"
    ) as c:
        r = await c.get("/api/v1/settings")
        assert r.status_code == 200
        body = r.json()
        assert "path" in body and "thread" in body and "rate_limit" in body

        r2 = await c.post(
            "/api/v1/settings", json={"thread": 7, "rate_limit": 1.5}
        )
        assert r2.status_code == 200

        r3 = await c.get("/api/v1/settings")
        assert r3.json()["thread"] == 7
        assert r3.json()["rate_limit"] == 1.5


@pytest.mark.asyncio
async def test_cancel_nonexistent_returns_404(tmp_path):
    app = await _build_test_app(tmp_path)
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://t"
    ) as c:
        r = await c.post("/api/v1/jobs/nope/cancel")
        assert r.status_code == 404


@pytest.mark.asyncio
async def test_events_nonexistent_returns_404(tmp_path):
    app = await _build_test_app(tmp_path)
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://t"
    ) as c:
        r = await c.get("/api/v1/jobs/nope/events")
        assert r.status_code == 404
