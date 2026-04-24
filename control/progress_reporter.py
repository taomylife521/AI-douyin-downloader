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
            try:
                self._queue.get_nowait()
            except asyncio.QueueEmpty:
                pass
            try:
                self._queue.put_nowait(payload)
            except asyncio.QueueFull:
                pass

    def on_job_start(self, *, url: str, url_type: str, total: Optional[int]) -> None:
        self._emit("job-start", {"url": url, "url_type": url_type, "total": total})

    def on_item_start(self, *, aweme_id: str, index: int, total: int, title: str) -> None:
        self._emit("item-start", {"aweme_id": aweme_id, "index": index, "total": total, "title": title})

    def on_item_progress(self, *, aweme_id: str, bytes_read: int, bytes_total: int) -> None:
        self._emit("item-progress", {"aweme_id": aweme_id, "bytes_read": bytes_read, "bytes_total": bytes_total})

    def on_item_complete(self, *, aweme_id: str, status: str, file_paths: List[str]) -> None:
        self._emit("item-complete", {"aweme_id": aweme_id, "status": status, "file_paths": file_paths})

    def on_log(self, *, level: str, message: str, type: Optional[str] = None) -> None:
        data: Dict[str, Any] = {"level": level, "message": message}
        if type:
            data["type"] = type
        self._emit("log", data)

    def on_job_done(self, *, total: int, success: int, failed: int, skipped: int) -> None:
        self._emit("done", {"total": total, "success": success, "failed": failed, "skipped": skipped})

    def on_error(self, *, message: str, fatal: bool) -> None:
        self._emit("error", {"message": message, "fatal": fatal})
