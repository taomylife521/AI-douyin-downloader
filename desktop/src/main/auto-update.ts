export function initAutoUpdate(): void {
  // Lazy-load so electron-updater isn't imported in dev / tests.
  import('electron-updater')
    .then(({ autoUpdater }) => {
      autoUpdater.autoDownload = true
      autoUpdater.on('error', (e) => console.error('autoUpdate error', e))
      autoUpdater
        .checkForUpdatesAndNotify()
        .catch((e) => console.warn('update check failed', e))
    })
    .catch((e) => console.warn('autoUpdate import failed', e))
}
