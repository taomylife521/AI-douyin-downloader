#!/usr/bin/env python3
"""Entry point for the Douyin Downloader.

When invoked from source (`python run.py`), behaves as it always has:
chdir to the repo root so relative paths in `config.yml` resolve under
the project. When frozen by PyInstaller (the desktop sidecar), `__file__`
points inside `sys._MEIPASS` — a temp directory that PyInstaller wipes
on process exit. Chdir-ing there would silently destroy every download,
the cookie file, and the SQLite DB on every app shutdown. Instead, we
chdir to a stable per-user app-data dir, and default downloads to the
user's visible Downloads folder.
"""

import os
import sys
from pathlib import Path

project_root = Path(__file__).resolve().parent
sys.path.insert(0, str(project_root))


def _frozen_data_dir() -> Path:
    """Per-user app-data dir. Cookies, SQLite DB, runtime state live here."""
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "DouyinDownloader"
    if sys.platform == "win32":
        appdata = os.environ.get("APPDATA") or str(Path.home())
        return Path(appdata) / "DouyinDownloader"
    xdg = os.environ.get("XDG_DATA_HOME") or str(Path.home() / ".local" / "share")
    return Path(xdg) / "DouyinDownloader"


def _frozen_downloads_dir() -> Path:
    """Default downloads dir — visible to the user.

    macOS / Linux: ~/Downloads (the system Downloads folder; per-author subdirs
    are created beneath it by the file manager).
    Windows: %USERPROFILE%/Downloads.
    """
    return Path.home() / "Downloads"


if getattr(sys, "frozen", False):
    data_dir = _frozen_data_dir()
    data_dir.mkdir(parents=True, exist_ok=True)
    os.chdir(str(data_dir))

    # Override the default downloads path unless the user already set one.
    # ConfigLoader reads `DOUYIN_PATH` (see config/config_loader.py:57).
    if not os.environ.get("DOUYIN_PATH"):
        downloads = _frozen_downloads_dir()
        # ~/Downloads exists on every reasonable macOS / Windows install; if a
        # weird headless setup doesn't have it, fall back to the data dir.
        try:
            downloads.mkdir(parents=True, exist_ok=True)
            os.environ["DOUYIN_PATH"] = str(downloads)
        except OSError:
            os.environ["DOUYIN_PATH"] = str(data_dir / "Downloads")
else:
    os.chdir(str(project_root))


if __name__ == "__main__":
    from cli.main import main

    main()
