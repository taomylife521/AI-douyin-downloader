import { app, BrowserWindow, ipcMain, dialog } from 'electron'
import { getSidecarInfo } from './sidecar'
import { openLoginWindow } from './login-window'

export function registerIpc(): void {
  ipcMain.handle('sidecar:info', () => getSidecarInfo())

  ipcMain.handle('login:open', async (event) => {
    const parent = BrowserWindow.fromWebContents(event.sender) ?? undefined
    await new Promise<void>((resolve) => {
      openLoginWindow(parent, () => {
        event.sender.send('cookies:changed')
        resolve()
      }).catch((err) => {
        console.error(err)
        resolve()
      })
    })
  })

  ipcMain.handle('dialog:choose-directory', async (event) => {
    const parent = BrowserWindow.fromWebContents(event.sender) ?? undefined
    const res = await dialog.showOpenDialog(parent!, {
      properties: ['openDirectory', 'createDirectory'],
    })
    if (res.canceled || res.filePaths.length === 0) return null
    return res.filePaths[0]
  })

  ipcMain.handle('app:version', () => app.getVersion())
}
