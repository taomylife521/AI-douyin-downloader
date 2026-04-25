# DouyinDownloader Desktop（Electron）

跨平台桌面壳，内嵌 Python 后端（PyInstaller 打包），用户无需安装 Python。

## 架构

三进程模型：Electron Main（Node.js）拉起 Python sidecar（FastAPI on `127.0.0.1:<random-port>`），Renderer（React）通过 HTTP + SSE 跟 sidecar 通信。Main 还负责内嵌登录窗口（抓 Douyin cookie）和自动更新。

详见 `docs/superpowers/specs/2026-04-24-desktop-app-electron-design.md`。

## 用户安装

### macOS

1. 从 [Releases](https://github.com/jiji262/douyin-downloader/releases) 下载对应架构的 `.dmg`：
   - Apple Silicon: `DouyinDownloader-X.Y.Z-arm64.dmg`
   - Intel: `DouyinDownloader-X.Y.Z.dmg`
2. 双击安装到 Applications。
3. 未签名版本首次运行如提示"无法打开，可能损坏"：
   - 终端执行：`xattr -cr /Applications/DouyinDownloader.app`
   - 或"系统设置 → 隐私与安全 → 仍要打开"

### Windows

1. 下载 `.exe` 安装包。
2. SmartScreen 警告时点击"更多信息 → 仍要运行"。

## 登录

首次启动会在首页提示"尚未登录抖音"。点击"登录"打开内嵌登录窗口，像平时一样登录抖音即可——不需要手动复制 cookie，app 会自动捕获并写入后端。

## 开发

### 前置

- Node 20 LTS
- Python 3.11（PyInstaller 最稳定的版本；3.12+ 也能跑但未在所有平台充分测试）

### 首次安装

```bash
# 项目根
pip install -e ".[server,dev]"

# desktop/
cd desktop
npm install
```

### 启动（两种方式）

**方式 1：跑打包后的 sidecar**

```bash
cd desktop
npm run build:sidecar        # PyInstaller 生成 sidecar
npm run dev                  # 启 Vite + Electron
```

**方式 2：dev-mode fallback（无 sidecar 二进制时）**

只要 `desktop/resources/sidecar/` 没有打包好的二进制，Main 会自动 fallback 到 `python -m cli.main --serve --serve-port 0`——直接用系统 Python 跑后端，改 Python 代码无需重新打包。

```bash
cd desktop
npm run dev
```

如果想强制走 Python（即使 sidecar 存在）：

```bash
DOUYIN_USE_PY=1 npm run dev
```

### 生产打包

```bash
cd desktop
npm run build:sidecar
npm run build
npm run dist:mac         # 或 dist:win
```

产物在 `desktop/dist-installer/`。

## 签名与公证

MVP 默认输出 **未签名** 构建。要出签名版本：

### macOS（需要 Apple Developer ID Application 证书，$99/年）

1. 把证书导入本地 keychain。
2. 设置环境变量：
   ```bash
   export APPLE_ID="you@example.com"
   export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
   export APPLE_TEAM_ID="ABC123XYZ"
   ```
3. 把 `electron-builder.yml` 里的 `mac.notarize` 改成 `true`。
4. `npm run dist:mac`。

### Windows（需要 Code Signing 证书，~$200/年）

1. 设置证书变量（推荐 EV 证书以避免 SmartScreen 警告）：
   ```bash
   export CSC_LINK="path/to/cert.pfx"    # 或 base64 字符串
   export CSC_KEY_PASSWORD="xxx"
   ```
2. 把 `electron-builder.yml` 里的 `win.signAndEditExecutable` 改成 `true`。
3. `npm run dist:win`。

## 自动更新

使用 `electron-updater` + GitHub Releases。Release 要用 `desktop-v*` tag 触发
`.github/workflows/desktop-release.yml`，该 workflow 会在三个 runner 上分别打包
mac-arm64 / mac-x64 / win-x64 并附加到 Release 页面。

## 测试

```bash
cd desktop
npm test            # Vitest：Main 单元测试 + Renderer 组件测试
npm run typecheck   # tsc --noEmit，分别检查 Renderer 和 Main
```

## 目录布局

```
desktop/
├── src/
│   ├── main/              Electron Main（Node.js）
│   │   ├── index.ts       app 入口
│   │   ├── sidecar.ts     启停 Python sidecar
│   │   ├── login-window.ts 内嵌登录 + cookie 抓取
│   │   ├── ipc.ts         IPC handler
│   │   └── auto-update.ts
│   ├── preload/           contextBridge 暴露安全 API
│   ├── renderer/          React 前端
│   │   ├── pages/         Home / Batch / History / Settings
│   │   ├── components/
│   │   ├── api/           fetch + EventSource 封装
│   │   └── store/         Zustand
│   └── shared/            Main/Renderer 共享类型
├── resources/
│   ├── entitlements.mac.plist
│   └── sidecar/           PyInstaller 产物（gitignored，构建时生成）
├── scripts/
│   ├── build-sidecar.sh
│   └── dev-run.mjs
├── electron-builder.yml
└── vite.config.ts
```
