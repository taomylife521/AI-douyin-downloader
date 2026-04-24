# Desktop App (Electron) — Design Spec

**Date:** 2026-04-24
**Status:** Approved — ready for implementation plan
**Scope:** MVP desktop application wrapping existing `douyin-downloader` Python backend

## 1. Goal & Non-Goals

### Goal

Ship a macOS (`.dmg`) and Windows (`.exe`) desktop installer that a non-technical
end user can double-click to use. No Python install required; no CLI knowledge
required; no manual cookie extraction required.

### Target user

Friends and family of the maintainer, non-technical. They receive a link or
installer, double-click, log in to Douyin through an embedded login window,
paste a URL or profile link, and see their downloads complete.

### MVP feature scope (approved)

- Paste single URL → download video / image-note / collection / music.
- Batch download from user profile with `mode ∈ {post, like, mix, music}`.
- Time-range filter (`start_time` / `end_time`) and count cap (`number.*`).
- Incremental download (skip already-downloaded).
- Choose output directory.
- Real-time progress (per-item + overall) via SSE from Python backend.
- Download history list from existing SQLite DB.
- Embedded login window (Electron `BrowserWindow`) that captures Douyin
  cookies without user copy-paste.
- Auto-update via GitHub Releases.

### Out-of-scope (explicitly deferred)

- Live stream recording (long-lived connections, ffmpeg muxing).
- Whisper transcription (1-2 GB model download, AV false-positive risk).
- Comment / hot-board / keyword search panels.
- Notification-push configuration panel (Bark / Telegram / Webhook).
- Internationalization (MVP is Chinese only; English is a follow-up).
- Linux `.AppImage` / `.deb` (technically feasible, deferred for distribution complexity).

## 2. Architecture

### Three-process model

```
┌────────────────── Electron App ──────────────────┐
│                                                   │
│  ┌────────────────┐     IPC      ┌────────────┐  │
│  │ Main Process   │ ◄──────────► │ Renderer   │  │
│  │ (Node.js)      │              │ (React UI) │  │
│  │ • Spawn Py     │              │            │  │
│  │ • Login window │              │ • fetch +  │  │
│  │ • Tray/menu    │              │   SSE →    │  │
│  │ • Auto-update  │              │   Sidecar  │  │
│  └────────┬───────┘              └──────┬─────┘  │
│           │ spawn                       │        │
│           ▼                             ▼        │
│  ┌──────────────────────────────────────────┐    │
│  │  Python Sidecar (PyInstaller onefile)    │    │
│  │  douyin-dl-sidecar --serve --port=0      │    │
│  │  FastAPI on 127.0.0.1:<os-assigned>      │    │
│  └──────────────────────────────────────────┘    │
└───────────────────────────────────────────────────┘
```

### Contract boundaries

- **Electron ↔ Python**: HTTP over `127.0.0.1` (OS-assigned port, announced
  over stdout on sidecar startup). Progress and logs use Server-Sent Events.
- **Main ↔ Renderer**: Electron `contextBridge` exposes a narrow typed API
  (open login window, get sidecar port, get/set app settings). Renderer does
  NOT get raw `ipcRenderer`; no `nodeIntegration` in Renderer.
- **Main ↔ Sidecar lifecycle**: Main spawns sidecar on app ready, kills on
  `before-quit`. Main polls `/api/v1/health` every 2 s; on two consecutive
  failures, restarts sidecar once. If restart also fails, show error dialog
  and quit.

### Why HTTP instead of stdio?

SSE gives us progress / logs / cancel / status query for free, is debuggable
with `curl`, and already exists in `server/app.py`. stdio would require a
custom protocol, custom framing, custom test harness.

### Development-mode escape hatch

`npm run dev` starts Vite + Electron Main with hot reload and connects to a
manually-started `python -m cli.main --serve --serve-port 8000` — bypassing
sidecar spawn. Lets us iterate on the backend without rebuilding PyInstaller
every change.

## 3. Repository Layout

Monorepo with `desktop/` subdirectory. Toolchains kept strictly separated.

```
douyin-downloader/
├── cli/  core/  auth/  config/ ...      # existing Python, untouched
├── server/                              # existing FastAPI, extended (§ 5)
├── tests/                               # existing pytest + new server tests
├── pyproject.toml                       # existing, unchanged
│
├── desktop/                             # NEW: Electron workspace
│   ├── package.json
│   ├── tsconfig.json
│   ├── vite.config.ts
│   ├── electron-builder.yml
│   ├── src/
│   │   ├── main/                        # Node.js
│   │   │   ├── index.ts
│   │   │   ├── sidecar.ts               # spawn / monitor / kill Python
│   │   │   ├── login-window.ts          # Douyin login, cookie capture
│   │   │   ├── auto-update.ts
│   │   │   └── ipc.ts
│   │   ├── preload/
│   │   │   └── index.ts                 # contextBridge surface
│   │   ├── renderer/                    # React (Vite)
│   │   │   ├── main.tsx
│   │   │   ├── App.tsx
│   │   │   ├── pages/{Home,Batch,History,Settings}.tsx
│   │   │   ├── components/
│   │   │   ├── api/                     # fetch + EventSource wrappers
│   │   │   └── store/                   # Zustand
│   │   └── shared/                      # types shared Main ↔ Renderer
│   ├── resources/
│   │   ├── icon.icns / icon.ico
│   │   └── sidecar/                     # filled by scripts/build-sidecar
│   ├── scripts/
│   │   ├── build-sidecar.sh
│   │   └── dev-run.sh
│   └── README.md
│
├── .github/workflows/
│   ├── ci.yml                           # existing: Python pytest + ruff
│   └── desktop-release.yml              # NEW: tag-triggered, build dmg/exe
│
└── .gitignore                           # add desktop/node_modules, dist, ...
```

### Rules

- Zero Python code inside `desktop/`; zero Node/TS outside `desktop/`.
  The only crossing is `desktop/scripts/build-sidecar.sh` invoking PyInstaller.
- `desktop/package.json` lists **zero** Python deps; root `pyproject.toml`
  lists **zero** Node deps.
- CI jobs are split: `ci.yml` keeps Python-only concerns; `desktop-release.yml`
  triggers only on `desktop-v*` tags.
- Versioning: Python stays on `pyproject.toml` (`2.x.y`); desktop uses
  `desktop/package.json` (`0.1.0` starting). Desktop records its embedded
  backend version in a `resources/sidecar-version.json` dropped at build.

## 4. Frontend Stack (approved recommendations)

- **Vite + React 18 + TypeScript** — mainstream Electron combo, fast HMR.
- **Zustand** for state — lighter than Redux, more maintainable than Context
  at our scope.
- **shadcn/ui + Tailwind CSS** — copy-in components based on Radix; no heavy
  component library bundle.
- **React Router** — four routes: `/` (home), `/batch`, `/history`, `/settings`.
- **fetch + EventSource** — no axios / no SSE library needed; EventSource is
  native.

## 5. Python API Extensions

All additions live in `server/app.py` and `server/jobs.py`. Existing endpoints
stay behavior-compatible.

### New/modified endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/v1/cookies` | Accept `{ cookies: {name: value, ...} }`, persist to CookieManager and on disk. |
| `GET` | `/api/v1/cookies/status` | Return `{ logged_in: bool, sec_uid?: string, expires_at?: iso8601 }`. |
| `POST` | `/api/v1/download` | Extended body: `{ url, mode?: ['post'\|'like'\|'mix'\|'music'], start_time?, end_time?, number?, increment?: bool, output_dir? }`. Existing `{ url }` shape stays valid. |
| `GET` | `/api/v1/jobs/{id}/events` | SSE stream: `progress`, `item-complete`, `log`, `done`, `error`. |
| `GET` | `/api/v1/history` | Paginated list from SQLite `aweme` table. Query: `?page=1&size=50&author=&date_from=&date_to=&mode=`. |
| `POST` | `/api/v1/jobs/{id}/cancel` | Best-effort cancellation; set job status to `cancelled`. |
| `GET` | `/api/v1/settings` / `POST` | Expose the subset of `config.yml` the GUI manipulates (output path, concurrency, rate limit). |

### Internal changes

- Introduce `ProgressReporter` abstraction in `control/` so the same downloader
  code paths emit events to either rich CLI or SSE broker. Reporter interface:
  `on_job_start`, `on_item_start`, `on_item_progress(bytes_read, total)`,
  `on_item_complete(metadata)`, `on_item_error`, `on_job_done`.
- `server/jobs.py`: each `Job` gets an `asyncio.Queue` for events. SSE endpoint
  consumes this queue; multiple SSE consumers allowed via fan-out if needed
  (MVP: single consumer).
- `sse-starlette` becomes a server extra dependency. Add to `pyproject.toml`
  `[project.optional-dependencies].server`.
- Cancellation uses `asyncio.Task.cancel()` on the executor task; existing
  job lifecycle already tracks the task handle.

### Compatibility rule

CLI behavior must not regress. All server-mode additions go behind the
`--serve` code path; default CLI run is untouched.

### Contract details (for Main ↔ Sidecar)

**Sidecar startup protocol.** The PyInstaller binary accepts
`--serve --serve-host 127.0.0.1 --serve-port 0` and must emit **exactly one**
line on stdout before any other output:

```
DOUYIN_SIDECAR_READY port=<int> pid=<int>
```

Main reads stdout line-by-line until this marker appears (or a 30 s timeout
fires). After the marker, Main ignores stdout but continues reading stderr
into an in-memory ring buffer (for crash diagnostics).

**SSE event schema.** All events from `GET /api/v1/jobs/{id}/events` are
JSON-encoded in the SSE `data:` field. `event:` names are:

| event | data shape |
|---|---|
| `job-start` | `{ job_id, url, url_type, total: int \| null }` |
| `item-start` | `{ aweme_id, index, total, title }` |
| `item-progress` | `{ aweme_id, bytes_read, bytes_total }` |
| `item-complete` | `{ aweme_id, status: 'ok'\|'failed'\|'skipped', file_paths: string[] }` |
| `log` | `{ level: 'info'\|'warn'\|'error', message, type?: 'auth-required'\|'rate-limited' }` |
| `done` | `{ total, success, failed, skipped }` |
| `error` | `{ message, fatal: bool }` |

Events are fire-and-forget; if no consumer is attached the queue buffers up
to 1000 events then drops oldest (prevents memory growth on long jobs with no
UI attached).

**Cancellation semantics.** `POST /api/v1/jobs/{id}/cancel` sets the job's
status to `cancelling`, cancels the underlying `asyncio.Task`, and sets
terminal status `cancelled` once the task returns. **Partial downloads are
kept**; existing cleanup of truncated files runs as usual. Already-completed
items stay on disk.

## 6. Login & Cookie Flow

The biggest UX win of the desktop app. Non-technical users never see a cookie.

### Sequence

1. On first launch, if `/api/v1/cookies/status` returns `logged_in: false`,
   Renderer shows a "Log in to Douyin" banner on Home.
2. User clicks "Log in". Renderer calls `window.api.openLoginWindow()` via
   preload bridge.
3. Main opens a new `BrowserWindow` navigating to `https://www.douyin.com/`
   (default Douyin web home includes login widget). Window uses its own
   `session.fromPartition('persist:douyin-login')` so cookies survive relaunch.
4. Main listens for `session.cookies.changed`. On each change, check for
   presence of key cookies (`sessionid_ss`, `ttwid`, `passport_csrf_token`,
   `sid_guard`). When all present and non-empty, consider login complete.
5. Main calls `session.cookies.get({ url: 'https://www.douyin.com' })`,
   serializes cookies as `{name: value}`, closes the login window, and posts
   to `POST /api/v1/cookies`.
6. Python side: receives cookies, writes to `.cookies.json`, re-initializes
   `CookieManager`, returns `{ ok: true, sec_uid: <parsed from profile API> }`.
7. Renderer polls `/api/v1/cookies/status` every 500 ms while the login window
   is open and updates UI when `logged_in: true`.

### Edge cases

- **CAPTCHA**: embedded webview renders and handles CAPTCHA natively — user
  solves it inside the login window. We don't need to automate it.
- **Login expiration**: backend detects 401/403 on Douyin API and fires a
  `log` event with `type: auth-required`; Renderer surfaces a "session
  expired, please re-login" banner.
- **Cookie domain quirks**: Douyin sets cookies on multiple subdomains. We
  query all of `.douyin.com`, `.iesdouyin.com`, `www.douyin.com` and union
  them. Duplicate keys: latest wins by `expires` timestamp.

### Security notes

- Login window is `partition: 'persist:douyin-login'`, isolated from other
  Electron sessions. `nodeIntegration: false`, `contextIsolation: true`.
- Cookies are persisted by Python side to the app's userData directory with
  `0600` permissions on POSIX. Not written to logs.
- We do not embed any credentials / tokens in the packaged app.

## 7. Signing & Distribution

### macOS

- Requires **Apple Developer ID Application** cert ($99 / yr). Managed by
  user; stored outside the repo.
- `electron-builder`:
  - `mac.identity: <Developer ID Application: ...>`
  - `mac.notarize: true` (uses `notarytool`, requires Apple ID + app-specific
    password exposed as `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` env vars).
  - `dmg`: compression + default background.
  - Hardened runtime entitlements: allow `com.apple.security.network.client`
    (HTTP to sidecar and to Douyin), `com.apple.security.files.user-selected.read-write`
    (output folder picker).
- Target: both `arm64` (Apple Silicon) and `x64` (Intel). Two dmg artifacts.

### Windows

- Requires **Standard Code Signing cert** (~$200 / yr). EV cert is better
  (bypasses SmartScreen immediately) but expensive; not MVP.
- `electron-builder`:
  - `win.certificateFile: <pfx path>` or `CSC_LINK` env var.
  - `target: nsis` — produces `.exe` installer.
  - `publisherName` must match cert subject.
- Target: `x64` only (arm64 Windows adoption is still low).

### Unsigned fallback (documented for MVP)

If the user doesn't have certs yet, build unsigned and document the override
steps in `desktop/README.md`:

- macOS: `xattr -cr /Applications/DouyinDownloader.app`
- Windows: "More info → Run anyway" on SmartScreen

This is acceptable for the **friends-and-family MVP**; upgrade to signed
builds once certs are in hand.

## 8. Auto-Update

- `electron-updater` + GitHub Releases.
- Publisher config in `electron-builder.yml`:
  ```yaml
  publish:
    provider: github
    owner: jiji262
    repo: douyin-downloader
  ```
- CI workflow uploads release assets to the tagged GitHub Release.
- On app start, Main calls `autoUpdater.checkForUpdates()` with user preference
  from settings: `auto` (default) / `notify-only` / `off`.
- Update channels: `latest` only for MVP. `beta` channel is a follow-up.

## 9. Development & Build Workflow

### Prerequisites

- Node 20 LTS
- Python 3.11 (PyInstaller's reliable baseline; `pyproject.toml` already
  supports 3.8+, but PyInstaller + macOS notarization is best-tested on 3.11)
- Rust toolchain: not required (we chose Electron, not Tauri).

### Commands

```bash
# First-time setup (from repo root)
uv sync --group desktop              # or: pip install -e ".[server,dev]"
cd desktop && npm ci

# Dev (two terminals)
# Terminal 1
python -m cli.main --serve --serve-port 8000
# Terminal 2
cd desktop && npm run dev             # Vite + Electron main, HMR

# Production build (single command)
cd desktop
npm run build:sidecar                 # PyInstaller → resources/sidecar/
npm run build                         # tsc + vite build
npm run dist:mac                      # outputs dist/*.dmg
npm run dist:win                      # outputs dist/*.exe (cross-build from mac uses wine; CI runs on Windows runner)
```

### PyInstaller config

- `desktop/scripts/build-sidecar.sh` runs:
  ```bash
  pyinstaller \
    --onefile \
    --name douyin-dl-sidecar \
    --hidden-import=sse_starlette \
    --collect-submodules=core \
    --collect-submodules=auth \
    run.py
  ```
- Output per platform: `douyin-dl-sidecar` (macOS / Linux) or
  `douyin-dl-sidecar.exe` (Windows). Placed in
  `desktop/resources/sidecar/<platform>-<arch>/`.
- Cross-building is not supported; macOS arm64 + x64 and Windows x64 each
  built on their respective CI runner.

## 10. Testing Strategy

| Level | Scope | Tool |
|---|---|---|
| Unit — Python | existing + new `tests/test_server_extensions.py` covering cookies endpoint, SSE broker, jobs cancel, history query | pytest |
| Unit — Main | `sidecar.ts`, `ipc.ts`, `login-window.ts` cookie merge logic | Vitest |
| Unit — Renderer | hooks, store, API client | Vitest + React Testing Library |
| Integration | Python server: start real uvicorn, hit endpoints with httpx | pytest + httpx |
| E2E | Launch Electron with fake sidecar, verify main happy path | Playwright Electron |
| Manual smoke | macOS + Windows real install: login → single download → batch download → history | human |

### CI coverage

- `ci.yml` runs unit + integration (Python) and unit (Node) on every push.
- `desktop-release.yml` runs full build + Playwright E2E on tag push.

## 11. Security / Privacy

- Sidecar binds to `127.0.0.1` only; port randomized; no inbound access from
  outside the host.
- Cookies encrypted-at-rest: out of scope for MVP (file perms + userData dir
  are the MVP guardrail). Follow-up: OS keychain integration.
- Downloaded content stays local; no telemetry; no crash reporting to a
  remote service without explicit opt-in.
- Renderer `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`
  where compatible with preload.
- Main does not execute user-supplied shell arguments; sidecar args are a
  fixed set (port + log level + data dir).

## 12. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| PyInstaller onefile startup latency (~1-2 s on cold launch, unpacks to temp) | Show a "Starting engine..." splash in Main until `/health` returns 200. |
| macOS Gatekeeper / Windows SmartScreen block unsigned builds | §7 documents override steps; signed builds are §7 upgrade path. |
| Douyin changes login page DOM | Cookie capture is DOM-agnostic (we hook `session.cookies.changed`); only the set of "required cookie names" might need updating. |
| SQLite history schema drift | Backend already emits stable JSON via existing manifest writer; GUI consumes that shape, not raw rows. |
| Whisper / browser optional deps slip into bundle | `pyinstaller --exclude-module playwright --exclude-module whisper` to keep bundle lean. |
| GitHub Actions macOS runner minute cost | Release workflow only runs on tag push, not on every commit. |
| Re-login loops on session expiration | Debounce: only prompt once per minute; manual "relogin" always works. |

## 13. Blocked on User

The following cannot be completed by the implementer and need explicit user
action:

- Apple Developer ID Application certificate ($99/yr) — required for
  `notarize: true` on macOS distribution.
- Windows Code Signing certificate (~$200/yr) — required to bypass SmartScreen
  reputation warnings.
- First-time Douyin login test (CAPTCHA solving is a human step).
- Real-device install smoke test on both platforms (implementer does not have
  Windows machine available).

Until certs are provisioned, all builds ship **unsigned** with documented
override steps in `desktop/README.md`.

## 14. Delivery Phases (input for writing-plans)

1. **Phase 1 — Python backend extensions** (self-contained, pytest-verifiable)
   - `ProgressReporter` abstraction
   - `server/app.py` new endpoints (cookies, cookies/status, jobs events,
     history, jobs cancel, settings)
   - `sse-starlette` dependency add
   - New pytest coverage
2. **Phase 2 — Electron scaffold**
   - `desktop/` project init (Vite + React + TS + Electron)
   - `electron-builder.yml` skeleton
   - Main process structure (sidecar.ts, login-window.ts, ipc.ts, auto-update.ts)
   - Preload contextBridge surface
   - Renderer base: routing, layout, empty pages
3. **Phase 3 — Renderer feature implementation**
   - Home (paste URL → download)
   - Batch (profile batch mode + filters)
   - History (list + filter)
   - Settings (output dir, concurrency, rate limit, update channel)
4. **Phase 4 — Build pipeline**
   - `scripts/build-sidecar.sh` (PyInstaller)
   - `scripts/dev-run.sh` (concurrent dev startup)
   - npm scripts wire-up
5. **Phase 5 — CI & release**
   - `desktop-release.yml` workflow: matrix mac + win, upload to GitHub Release
   - electron-updater wiring
6. **Phase 6 — Docs & polish**
   - `desktop/README.md` (install, dev, build, troubleshooting)
   - Root README amendment mentioning desktop app
   - Update `AGENTS.md` / `CLAUDE.md` with desktop/ subtree rules
7. **Phase 7 — Code review + fixes**
   - Independent code review
   - Triage + fix findings

Each phase ships self-contained commits. Phase 7 gates final merge.

## 15. Approval

All decisions in §1–§14 are locked. Subsequent plans should reference this
spec by filename. Changes to the spec require an explicit new revision in the
same directory.
