#!/usr/bin/env bash
# Build the Python sidecar into desktop/resources/sidecar/<platform>-<arch>/.
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

# Use the repo .venv if present, otherwise the caller's Python.
PY="${PY:-$(command -v python3 || command -v python)}"
if [ -x ".venv/bin/python" ]; then
  PY=".venv/bin/python"
fi

if ! "${PY}" -c "import PyInstaller" 2>/dev/null; then
  "${PY}" -m pip install pyinstaller
fi

# Make sure runtime deps are present in the chosen interpreter.
"${PY}" -m pip install -e ".[server]"

"${PY}" -m PyInstaller \
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

# Record embedded backend version metadata (python-only, no toml lib fallback).
"${PY}" - <<'PY' > "${OUT_DIR}/sidecar-version.json"
import json, pathlib, sys
try:
    import tomllib  # Python 3.11+
except ImportError:
    import tomli as tomllib  # fallback for older Pythons
data = tomllib.loads(pathlib.Path("pyproject.toml").read_text())
print(json.dumps({"backend_version": data["project"]["version"]}))
PY

echo "Sidecar built: ${OUT_DIR}/douyin-dl-sidecar"
