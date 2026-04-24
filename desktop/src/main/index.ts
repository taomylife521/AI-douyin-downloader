import { app, BrowserWindow } from 'electron'
import path from 'node:path'
import { startSidecar, stopSidecar } from './sidecar'
import { registerIpc } from './ipc'
import { initAutoUpdate } from './auto-update'

const isDev = !app.isPackaged

let mainWindow: BrowserWindow | null = null

async function createMainWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 820,
    minHeight: 580,
    title: '抖音下载器',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  if (isDev) {
    await mainWindow.loadURL('http://127.0.0.1:5173')
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    await mainWindow.loadFile(path.join(__dirname, '..', '..', 'dist', 'index.html'))
  }
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
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', async () => {
  if (BrowserWindow.getAllWindows().length === 0) await createMainWindow()
})

app.on('before-quit', async () => {
  await stopSidecar()
})
