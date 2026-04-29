export {}

declare global {
  interface Window {
    electronAPI: {
      selectDirectory: () => Promise<string | null>
      selectPdfs: () => Promise<string[]>
      getPathForFile: (file: File) => string
      openExternal: (url: string) => Promise<void>
      openCacheFolder: () => Promise<{ ok: boolean; path: string; error: string | null }>
      clearScholarSession: () => Promise<{ ok: boolean }>
      getScholarUserAgent: () => Promise<string>
      getBackendPort: () => Promise<number>
      readPdfFile: (filePath: string) => Promise<Uint8Array>
      writePdfFile: (filePath: string, bytes: Uint8Array) => Promise<void>
      listPdfsInDirectory: (directory: string) => Promise<string[]>
      showSaveAs: (options?: {
        title?: string
        defaultPath?: string
        buttonLabel?: string
        filters?: Array<{ name: string; extensions: string[] }>
      }) => Promise<string | null>
      onUpdateAvailable: (cb: (info: { version: string; releaseNotes?: unknown }) => void) => () => void
      onUpdateProgress: (cb: (progress: { percent: number }) => void) => () => void
      onUpdateDownloaded: (cb: () => void) => () => void
      onUpdateError: (cb: (message: string) => void) => () => void
      onUpdateNotAvailable: (cb: () => void) => () => void
      downloadUpdate: () => void
      cancelUpdate: () => void
      installUpdate: () => void
    }
  }
}
