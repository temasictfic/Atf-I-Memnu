declare module 'electron-updater' {
  import type { AppUpdater } from 'electron-updater/out/AppUpdater'

  export const autoUpdater: AppUpdater
}
