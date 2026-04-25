"""Verify run.py's frozen-mode logic without actually freezing.

We can't run a PyInstaller binary in pytest, but we can import run.py with
sys.frozen monkey-patched and assert the chdir + DOUYIN_PATH side effects.
"""
from __future__ import annotations

import importlib
import os
import runpy
import sys
from pathlib import Path

import pytest


@pytest.fixture
def isolated_env(monkeypatch, tmp_path):
    """Pretend HOME is tmp_path so we don't touch the real ~/Library or ~/Downloads."""
    fake_home = tmp_path / "home"
    fake_home.mkdir()
    monkeypatch.setenv("HOME", str(fake_home))
    # On Windows, run.py reads APPDATA; mirror it.
    monkeypatch.setenv("APPDATA", str(fake_home / "AppData" / "Roaming"))
    monkeypatch.setenv("XDG_DATA_HOME", str(fake_home / ".local" / "share"))
    monkeypatch.delenv("DOUYIN_PATH", raising=False)
    yield fake_home


def _exec_run_py_frozen(monkeypatch, *, sys_frozen: bool):
    monkeypatch.setattr(sys, "frozen", sys_frozen, raising=False)
    # Run the file as a module-like script but stop before main() executes.
    # We can't use runpy.run_path because it'd try to import cli.main.
    # Instead, exec the relevant top-level setup directly.
    import run as run_module  # type: ignore

    importlib.reload(run_module)
    return run_module


@pytest.mark.skipif(
    sys.platform == "win32",
    reason="windows path semantics differ; covered manually",
)
def test_frozen_changes_cwd_and_sets_path(isolated_env, monkeypatch):
    original_cwd = os.getcwd()
    try:
        _exec_run_py_frozen(monkeypatch, sys_frozen=True)
        cwd = Path(os.getcwd()).resolve()
        if sys.platform == "darwin":
            expected = (
                isolated_env / "Library" / "Application Support" / "DouyinDownloader"
            ).resolve()
        else:
            expected = (
                isolated_env / ".local" / "share" / "DouyinDownloader"
            ).resolve()
        assert cwd == expected, f"frozen CWD {cwd} != {expected}"
        assert os.environ.get("DOUYIN_PATH"), "DOUYIN_PATH should be set when frozen"
        downloads_path = Path(os.environ["DOUYIN_PATH"]).resolve()
        assert downloads_path == (isolated_env / "Downloads").resolve()
        assert downloads_path.exists()
    finally:
        os.chdir(original_cwd)


def test_unfrozen_preserves_existing_behavior(isolated_env, monkeypatch):
    original_cwd = os.getcwd()
    try:
        _exec_run_py_frozen(monkeypatch, sys_frozen=False)
        cwd = Path(os.getcwd()).resolve()
        repo_root = Path(__file__).resolve().parent.parent
        assert cwd == repo_root, f"unfrozen CWD {cwd} != repo root {repo_root}"
        assert "DOUYIN_PATH" not in os.environ
    finally:
        os.chdir(original_cwd)


def test_frozen_does_not_clobber_user_path(isolated_env, monkeypatch):
    monkeypatch.setenv("DOUYIN_PATH", "/explicit/user/choice")
    original_cwd = os.getcwd()
    try:
        _exec_run_py_frozen(monkeypatch, sys_frozen=True)
        assert os.environ["DOUYIN_PATH"] == "/explicit/user/choice"
    finally:
        os.chdir(original_cwd)
