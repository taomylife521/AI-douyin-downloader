import { contextBridge, ipcRenderer } from 'electron'
import type { ExposedApi, SidecarInfo } from '../shared/types'

const api: ExposedApi = {
  getSidecarInfo: () => ipcRenderer.invoke('sidecar:info') as Promise<SidecarInfo>,
  openLoginWindow: () => ipcRenderer.invoke('login:open'),
  onCookiesChanged: (cb) => {
    const handler = (): void => cb()
    ipcRenderer.on('cookies:changed', handler)
    return () => ipcRenderer.off('cookies:changed', handler)
  },
  chooseDirectory: () =>
    ipcRenderer.invoke('dialog:choose-directory') as Promise<string | null>,
  getAppVersion: () => ipcRenderer.invoke('app:version') as Promise<string>,
}

contextBridge.exposeInMainWorld('api', api)
