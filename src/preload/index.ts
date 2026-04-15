import { contextBridge, ipcRenderer } from 'electron'

interface UpdateAvailablePayload {
  version: string
  releaseNotes?: unknown
}

interface UpdateProgressPayload {
  percent: number
}

const electronAPI = {
  selectDirectory: (): Promise<string | null> => {
    return ipcRenderer.invoke('dialog:selectDirectory')
  },
  selectPdfs: (): Promise<string[]> => {
    return ipcRenderer.invoke('dialog:selectPdfs')
  },
  openExternal: (url: string): Promise<void> => {
    return ipcRenderer.invoke('shell:openExternal', url)
  },
  readPdfFile: (filePath: string): Promise<Uint8Array> => {
    return ipcRenderer.invoke('pdf:read', filePath)
  },
  writePdfFile: (filePath: string, bytes: Uint8Array): Promise<void> => {
    return ipcRenderer.invoke('pdf:write', filePath, bytes)
  },
  listPdfsInDirectory: (directory: string): Promise<string[]> => {
    return ipcRenderer.invoke('pdf:listDirectory', directory)
  },
  showSaveAs: (options?: {
    title?: string
    defaultPath?: string
    buttonLabel?: string
    filters?: Array<{ name: string; extensions: string[] }>
  }): Promise<string | null> => {
    return ipcRenderer.invoke('dialog:showSaveAs', options)
  },
  openCacheFolder: (): Promise<{ ok: boolean; path: string; error: string | null }> => {
    return ipcRenderer.invoke('shell:openCacheFolder')
  },
  getBackendPort: (): Promise<number> => {
    return ipcRenderer.invoke('backend:getPort')
  },
  onUpdateAvailable: (cb: (info: UpdateAvailablePayload) => void): (() => void) => {
    const listener = (_event: unknown, info: UpdateAvailablePayload) => cb(info)
    ipcRenderer.on('update:available', listener)
    return () => ipcRenderer.removeListener('update:available', listener)
  },
  onUpdateProgress: (cb: (progress: UpdateProgressPayload) => void): (() => void) => {
    const listener = (_event: unknown, progress: UpdateProgressPayload) => cb(progress)
    ipcRenderer.on('update:progress', listener)
    return () => ipcRenderer.removeListener('update:progress', listener)
  },
  onUpdateDownloaded: (cb: () => void): (() => void) => {
    const listener = () => cb()
    ipcRenderer.on('update:downloaded', listener)
    return () => ipcRenderer.removeListener('update:downloaded', listener)
  },
  onUpdateError: (cb: (message: string) => void): (() => void) => {
    const listener = (_event: unknown, message: string) => cb(message)
    ipcRenderer.on('update:error', listener)
    return () => ipcRenderer.removeListener('update:error', listener)
  },
  downloadUpdate: (): void => {
    ipcRenderer.send('update:download')
  },
  cancelUpdate: (): void => {
    ipcRenderer.send('update:cancel')
  },
  installUpdate: (): void => {
    ipcRenderer.send('update:install')
  }
}

contextBridge.exposeInMainWorld('electronAPI', electronAPI)

export type ElectronAPI = typeof electronAPI
