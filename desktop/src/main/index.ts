import { app, BrowserWindow } from 'electron'
import path from 'node:path'
import { startSidecar, stopSidecar, getSidecarInfo } from './sidecar'
import { registerIpc } from './ipc'
import { initAutoUpdate } from './auto-update'

const isDev = !app.isPackaged

let mainWindow: BrowserWindow | null = null
let healthPoller: NodeJS.Timeout | null = null
let quitting = false

async function createMainWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 820,
    minHeight: 580,
    title: 'DouyinDownloader',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  if (isDev) {
    await mainWindow.loadURL('http://127.0.0.1:5173')
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    await mainWindow.loadFile(path.join(__dirname, '..', '..', 'dist', 'index.html'))
  }
}

async function pingHealth(): Promise<boolean> {
  try {
    const { port } = getSidecarInfo()
    const r = await fetch(`http://127.0.0.1:${port}/api/v1/health`, {
      signal: AbortSignal.timeout(2500),
    })
    return r.ok
  } catch {
    return false
  }
}

function startHealthPoller(): void {
  let consecutiveFailures = 0
  let restartAttempts = 0
  healthPoller = setInterval(async () => {
    if (quitting) return
    const ok = await pingHealth()
    if (ok) {
      consecutiveFailures = 0
      return
    }
    consecutiveFailures += 1
    if (consecutiveFailures < 2) return

    // Two consecutive failures — attempt one restart.
    consecutiveFailures = 0
    if (restartAttempts >= 1) {
      const { dialog } = await import('electron')
      dialog.showErrorBox('服务异常', 'Python 后台服务已崩溃且重启失败。')
      app.quit()
      return
    }
    restartAttempts += 1
    console.warn('[health] restarting sidecar after 2 consecutive failures')
    try {
      await stopSidecar()
      await startSidecar()
      restartAttempts = 0
    } catch (err) {
      console.error('[health] restart failed:', err)
    }
  }, 5000)
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
  startHealthPoller()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', async () => {
  if (BrowserWindow.getAllWindows().length === 0) await createMainWindow()
})

// before-quit: prevent synchronous quit so we can cleanly stop the sidecar.
app.on('before-quit', (event) => {
  if (quitting) return
  event.preventDefault()
  quitting = true
  if (healthPoller) {
    clearInterval(healthPoller)
    healthPoller = null
  }
  stopSidecar()
    .catch((err) => console.error('stopSidecar error on quit:', err))
    .finally(() => app.exit(0))
})

// Defensive: if the process is terminated abruptly, at least try to kill the child.
process.on('exit', () => {
  try {
    // Best-effort; stopSidecar is async, but on `exit` we can only do sync work.
    // The SIGTERM in stopSidecar normally runs first via before-quit.
  } catch {
    /* ignore */
  }
})
