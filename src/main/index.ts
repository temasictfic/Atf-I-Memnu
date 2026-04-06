import { app, BrowserWindow, ipcMain, dialog, shell, Menu } from 'electron'
import { mkdirSync } from 'fs'
import { join } from 'path'
import { autoUpdater } from 'electron-updater'
import type { ProgressInfo, UpdateInfo } from 'builder-util-runtime'
import { startPythonBackend, stopPythonBackend } from './python-bridge'

const isDev = !app.isPackaged

let mainWindow: BrowserWindow | null = null
let updaterConfigured = false

function configureAutoUpdater(): void {
  if (isDev || updaterConfigured) return

  updaterConfigured = true
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('update-available', (info: UpdateInfo) => {
    mainWindow?.webContents.send('update:available', {
      version: info.version,
      releaseNotes: info.releaseNotes,
    })
  })

  autoUpdater.on('download-progress', (progress: ProgressInfo) => {
    mainWindow?.webContents.send('update:progress', {
      percent: progress.percent,
    })
  })

  autoUpdater.on('update-downloaded', () => {
    mainWindow?.webContents.send('update:downloaded')
  })

  autoUpdater.on('error', (err: Error) => {
    mainWindow?.webContents.send('update:error', err.message)
  })
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    title: 'Atf-ı Memnu - Academic Source Verification',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
    show: false
  })

  // Hide the native menu bar (File/Edit/View/Window/Help) on desktop.
  mainWindow.setMenuBarVisibility(false)

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()

    if (!isDev) {
      configureAutoUpdater()
      setTimeout(() => {
        autoUpdater.checkForUpdates().catch(() => {})
      }, 5000)
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// IPC Handlers
ipcMain.handle('dialog:selectDirectory', async () => {
  if (!mainWindow) return null
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Select PDF Directory'
  })
  return result.canceled ? null : result.filePaths[0]
})

ipcMain.handle('dialog:selectPdfs', async (_event, defaultPath?: string) => {
  if (!mainWindow) return []
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    title: 'Select PDF Files',
    defaultPath,
    filters: [
      { name: 'PDF Files', extensions: ['pdf'] },
    ],
  })
  return result.canceled ? [] : result.filePaths
})

ipcMain.handle('shell:openExternal', async (_event, url: string) => {
  await shell.openExternal(url)
})

ipcMain.handle('shell:openCacheFolder', async () => {
  const cacheDir = join(app.getPath('userData'), 'output', 'cache')
  mkdirSync(cacheDir, { recursive: true })
  const errorMessage = await shell.openPath(cacheDir)

  return {
    ok: errorMessage.length === 0,
    path: cacheDir,
    error: errorMessage.length === 0 ? null : errorMessage,
  }
})

ipcMain.handle('backend:getPort', () => {
  return 18765
})

ipcMain.on('update:download', () => {
  if (isDev) return
  autoUpdater.downloadUpdate().catch(() => {})
})

ipcMain.on('update:install', () => {
  if (isDev) return
  autoUpdater.quitAndInstall()
})

// App lifecycle
app.whenReady().then(async () => {
  Menu.setApplicationMenu(null)
  await startPythonBackend()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', async () => {
  await stopPythonBackend()
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', async () => {
  await stopPythonBackend()
})
