// Central pdfjs-dist configuration. Imported once; subsequent imports get the
// already-configured module. The worker URL is resolved via Vite's `?url`
// suffix, which copies the worker file into the renderer bundle and returns
// a URL usable at runtime.

import * as pdfjsLib from 'pdfjs-dist'
// Vite's `?url` copies the file verbatim — no minification — so we
// explicitly pick the pre-minified worker shipped by pdfjs-dist.
// @ts-expect-error Vite ?url import returns a string
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

let configured = false

export function getPdfjs(): typeof pdfjsLib {
  if (!configured) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl as string
    configured = true
  }
  return pdfjsLib
}
