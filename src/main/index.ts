import { app, BrowserWindow, ipcMain, dialog, shell, Menu } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { autoUpdater } from 'electron-updater'
import type { ProgressInfo, UpdateInfo } from 'builder-util-runtime'
import { startPythonBackend, stopPythonBackend, getPythonBackendPort } from './python-bridge'

const isDev = !app.isPackaged

let mainWindow: BrowserWindow | null = null
let updaterConfigured = false

interface UpdaterState {
  startupUpdateCheckCompleted?: boolean
}

const UPDATE_STATE_FILE = 'updater-state.json'
const IGNORED_UPDATE_ERRORS: RegExp[] = [
  /no published versions on github/i,
  /cannot find.*latest\.yml/i,
  /http error: 404/i,
  /status code 404/i,
]

function getUpdaterStatePath(): string {
  return join(app.getPath('userData'), UPDATE_STATE_FILE)
}

function readUpdaterState(): UpdaterState {
  const statePath = getUpdaterStatePath()
  if (!existsSync(statePath)) {
    return {}
  }

  try {
    const raw = readFileSync(statePath, 'utf8')
    const parsed = JSON.parse(raw) as UpdaterState
    if (!parsed || typeof parsed !== 'object') {
      return {}
    }
    return parsed
  } catch {
    return {}
  }
}

function writeUpdaterState(state: UpdaterState): void {
  const statePath = getUpdaterStatePath()
  try {
    writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8')
  } catch (error) {
    console.warn('[Updater] Failed to persist updater state:', error)
  }
}

function shouldRunStartupUpdateCheck(): boolean {
  if (isDev) {
    return false
  }

  const state = readUpdaterState()
  if (state.startupUpdateCheckCompleted) {
    return false
  }

  state.startupUpdateCheckCompleted = true
  writeUpdaterState(state)
  return true
}

function shouldForwardUpdateError(message: string): boolean {
  return !IGNORED_UPDATE_ERRORS.some(pattern => pattern.test(message))
}

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
    const message = err?.message || 'Unknown update error'
    console.warn('[Updater] Error:', message)
    if (!shouldForwardUpdateError(message)) {
      return
    }
    mainWindow?.webContents.send('update:error', message)
  })
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    title: 'Atf-ı Memnu - A citation search engine that looks for citations...',
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
      if (shouldRunStartupUpdateCheck()) {
        setTimeout(() => {
          autoUpdater.checkForUpdates().catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error)
            console.warn('[Updater] Startup check failed:', message)
          })
        }, 5000)
      }
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
  const port = getPythonBackendPort()
  if (port === null) {
    throw new Error('Backend port is not available yet')
  }
  return port
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
