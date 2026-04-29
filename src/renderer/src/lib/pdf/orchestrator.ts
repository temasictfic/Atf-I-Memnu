// Client-side parse orchestrator. Replaces the backend parse job: reads PDF
// bytes via the Electron fs IPC, parses them with pdfjs-dist, and runs the
// TypeScript source detector. The caller merges the result into pdf-store
// / sources-store exactly like the old backend parse flow did.
//
// Existing backend source cache persistence is preserved: we check
// api.getSources() first, and only fall back to fresh detection when no
// cache entry exists, so user edits and approvals carry over between runs.

import { api } from '../api/rest-client'
import type { SourceRectangle } from '../api/types'
import { parsePdf } from './parser'
import { detectSources } from './source-detector'

export interface ParseOutcome {
  pdfId: string
  name: string
  path: string
  sources: SourceRectangle[]
  numbered: boolean
  approved: boolean
  fromCache: boolean
  pageCount: number
  error?: string
}

function stemFromPath(filePath: string): string {
  const base = filePath.split(/[/\\]/).pop() ?? filePath
  return base.replace(/\.pdf$/i, '')
}

function nameFromPath(filePath: string): string {
  return filePath.split(/[/\\]/).pop() ?? filePath
}

export async function parseAndDetect(filePath: string): Promise<ParseOutcome> {
  const pdfId = stemFromPath(filePath)
  const name = nameFromPath(filePath)

  try {
    // Check the backend source cache first so prior edits + approvals survive.
    // The endpoint returns 200 with `cached: false` when nothing is stored so
    // devtools doesn't log a 404 for every fresh import.
    let cacheResult: { sources: SourceRectangle[]; numbered: boolean; approved: boolean } | null = null
    try {
      const res = await api.getSources(pdfId)
      if (res?.cached) {
        cacheResult = {
          sources: res.sources,
          numbered: res.numbered ?? res.sources.some(s => s.ref_number != null),
          approved: res.approved ?? false,
        }
      }
    } catch {
      cacheResult = null
    }

    const bytes = await window.electronAPI.readPdfFile(filePath)
    const parsed = await parsePdf(bytes, { id: pdfId, name, path: filePath })

    if (cacheResult !== null) {
      return {
        pdfId,
        name,
        path: filePath,
        sources: cacheResult.sources,
        numbered: cacheResult.numbered,
        approved: cacheResult.approved,
        fromCache: true,
        pageCount: parsed.pages.length,
      }
    }

    const { sources, numbered } = detectSources(parsed)

    // Persist freshly detected sources + numbered flag to the backend cache
    // so they survive reloads and so verification (which currently reads from
    // the same cache) can pick them up. Fire-and-forget on failure — users
    // can manually re-save from the UI.
    try {
      await api.updateSources(pdfId, sources, numbered)
    } catch (err) {
      console.warn(`[orchestrator] could not persist sources for ${pdfId}:`, err)
    }

    return {
      pdfId,
      name,
      path: filePath,
      sources,
      numbered,
      approved: false,
      fromCache: false,
      pageCount: parsed.pages.length,
    }
  } catch (err) {
    return {
      pdfId,
      name,
      path: filePath,
      sources: [],
      numbered: false,
      approved: false,
      fromCache: false,
      pageCount: 0,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
