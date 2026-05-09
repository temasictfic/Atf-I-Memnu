export interface SaveDialogOptions {
  title?: string
  defaultPath?: string
  buttonLabel?: string
  filters?: Array<{ name: string; extensions: string[] }>
}

export interface ElectronAPI {
  selectDirectory: (defaultPath?: string) => Promise<string | null>
  selectPdfs: () => Promise<string[]>
  selectTextFile: (defaultPath?: string) => Promise<string | null>
  readTextFile: (filePath: string) => Promise<string | null>
  openPath: (filePath: string) => Promise<{ ok: boolean; error: string | null }>
  getPathForFile: (file: File) => string
  openExternal: (url: string) => Promise<void>
  clearScholarSession: () => Promise<{ ok: boolean }>
  getScholarUserAgent: () => Promise<string>
  openCacheFolder: () => Promise<{ ok: boolean; path: string; error: string | null }>
  getBackendPort: () => Promise<number>
  readPdfFile: (filePath: string) => Promise<Uint8Array>
  writePdfFile: (filePath: string, bytes: Uint8Array) => Promise<void>
  listPdfsInDirectory: (directory: string) => Promise<string[]>
  showSaveAs: (options?: SaveDialogOptions) => Promise<string | null>
  onUpdateAvailable: (cb: (info: { version: string; releaseNotes?: unknown }) => void) => () => void
  onUpdateProgress: (cb: (progress: { percent: number }) => void) => () => void
  onUpdateDownloaded: (cb: () => void) => () => void
  onUpdateError: (cb: (message: string) => void) => () => void
  downloadUpdate: () => void
  installUpdate: () => void
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}
