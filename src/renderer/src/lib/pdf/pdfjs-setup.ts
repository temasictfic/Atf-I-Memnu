// Central pdfjs-dist configuration. Imported once; subsequent imports get the
// already-configured module. The worker URL is resolved via Vite's `?url`
// suffix, which copies the worker file into the renderer bundle and returns
// a URL usable at runtime.

import * as pdfjsLib from 'pdfjs-dist'
// Wrap the pdfjs worker in a shim that polyfills Math.sumPrecise — Electron 41's
// bundled Chromium predates V8 13.0 and pdfjs 5.x assumes it exists.
// @ts-expect-error Vite ?worker&url import returns a string
import pdfWorkerUrl from './pdf-worker-shim?worker&url'

let configured = false

export function getPdfjs(): typeof pdfjsLib {
  if (!configured) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl as string
    configured = true
  }
  return pdfjsLib
}
