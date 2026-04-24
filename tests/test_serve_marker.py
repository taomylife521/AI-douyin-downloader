import os
import re
import signal
import subprocess
import sys
import time
from pathlib import Path

import pytest


@pytest.mark.skipif(
    sys.platform == "win32", reason="signal handling differs on Windows"
)
def test_serve_emits_ready_marker():
    repo_root = Path(__file__).resolve().parent.parent
    env = {**os.environ, "PYTHONPATH": str(repo_root)}
    proc = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "cli.main",
            "--serve",
            "--serve-port",
            "0",
        ],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd=str(repo_root),
    )
    try:
        # Give the server up to 20 seconds to bind + print the marker.
        deadline = time.time() + 20.0
        line = None
        while time.time() < deadline:
            raw = proc.stdout.readline()
            if not raw:
                if proc.poll() is not None:
                    break
                continue
            candidate = raw.decode("utf-8", errors="replace").strip()
            if candidate.startswith("DOUYIN_SIDECAR_READY"):
                line = candidate
                break

        assert line is not None, (
            f"did not see ready marker. stderr tail:\n"
            f"{proc.stderr.read(2048).decode('utf-8', errors='replace')}"
        )
        m = re.match(r"DOUYIN_SIDECAR_READY port=(\d+) pid=(\d+)$", line)
        assert m is not None, f"bad marker format: {line!r}"
        port = int(m.group(1))
        assert 1 <= port <= 65535
    finally:
        proc.send_signal(signal.SIGINT)
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
