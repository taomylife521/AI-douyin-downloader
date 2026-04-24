import asyncio
import pytest
from control.progress_reporter import (
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
    assert ev1 == {
        "event": "job-start",
        "data": {"url": "https://x", "url_type": "video", "total": 1},
    }
    assert ev2["event"] == "item-complete"
    assert ev2["data"]["aweme_id"] == "a1"
    assert ev3 == {
        "event": "done",
        "data": {"total": 1, "success": 1, "failed": 0, "skipped": 0},
    }


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
