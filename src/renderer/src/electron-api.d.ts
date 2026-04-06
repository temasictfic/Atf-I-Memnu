export {}

declare global {
  interface Window {
    electronAPI: {
      selectDirectory: () => Promise<string | null>
      selectPdfs: (defaultPath?: string) => Promise<string[]>
      openExternal: (url: string) => Promise<void>
      openCacheFolder: () => Promise<{ ok: boolean; path: string; error: string | null }>
      getBackendPort: () => Promise<number>
      onUpdateAvailable: (cb: (info: { version: string; releaseNotes?: unknown }) => void) => () => void
      onUpdateProgress: (cb: (progress: { percent: number }) => void) => () => void
      onUpdateDownloaded: (cb: () => void) => () => void
      onUpdateError: (cb: (message: string) => void) => () => void
      downloadUpdate: () => void
      installUpdate: () => void
    }
  }
}
