import { create } from 'zustand'
import type { SourceRectangle } from '../api/types'
import { api } from '../api/rest-client'
import { usePdfStore } from './pdf-store'

interface SourcesState {
  sourcesByPdf: Record<string, SourceRectangle[]>
  originalSourcesByPdf: Record<string, SourceRectangle[]>
  historyByPdf: Record<string, SourceRectangle[][]>
}

export const useSourcesStore = create<SourcesState>()(() => ({
  sourcesByPdf: {},
  originalSourcesByPdf: {},
  historyByPdf: {},
}))

function updateSourceCount(pdfId: string, count: number): void {
  usePdfStore.getState().updateSourceCount(pdfId, count)
}

function pushHistory(pdfId: string): void {
  useSourcesStore.setState(state => {
    const history = state.historyByPdf[pdfId] ?? []
    const current = state.sourcesByPdf[pdfId] ?? []
    return {
      historyByPdf: { ...state.historyByPdf, [pdfId]: [...history, [...current]] },
    }
  })
}

function renumberSources(pdfId: string): void {
  useSourcesStore.setState(state => {
    const sources = state.sourcesByPdf[pdfId]
    if (!sources) return state
    const sorted = [...sources].sort((a, b) => {
      if (a.bbox.page !== b.bbox.page) return a.bbox.page - b.bbox.page
      return a.bbox.y0 - b.bbox.y0
    })
    const renumbered = sorted.map((s, i) => ({
      ...s,
      ref_number: i + 1,
      id: `${pdfId}_ref_${i + 1}`,
    }))
    return { sourcesByPdf: { ...state.sourcesByPdf, [pdfId]: renumbered } }
  })
}

export function getSources(pdfId: string): SourceRectangle[] {
  return useSourcesStore.getState().sourcesByPdf[pdfId] ?? []
}

export function setSources(pdfId: string, sources: SourceRectangle[]): void {
  useSourcesStore.setState(state => ({
    sourcesByPdf: { ...state.sourcesByPdf, [pdfId]: sources },
    originalSourcesByPdf: state.originalSourcesByPdf[pdfId]
      ? state.originalSourcesByPdf
      : { ...state.originalSourcesByPdf, [pdfId]: [...sources] },
  }))
  updateSourceCount(pdfId, sources.length)
}

export function addRectangle(pdfId: string, rect: SourceRectangle): void {
  pushHistory(pdfId)
  useSourcesStore.setState(state => ({
    sourcesByPdf: {
      ...state.sourcesByPdf,
      [pdfId]: [...(state.sourcesByPdf[pdfId] ?? []), rect],
    },
  }))
  renumberSources(pdfId)
  updateSourceCount(pdfId, useSourcesStore.getState().sourcesByPdf[pdfId]?.length ?? 0)
}

/**
 * Merge a source rectangle with its closest neighbor (by bbox center distance).
 * Same-page neighbors are preferred. Returns the id of the resulting merged source,
 * or null if there is no other source to merge with.
 */
export function mergeWithClosest(pdfId: string, sourceId: string): string | null {
  const all = useSourcesStore.getState().sourcesByPdf[pdfId] ?? []
  const target = all.find(s => s.id === sourceId)
  if (!target || all.length < 2) return null

  const targetCx = (target.bbox.x0 + target.bbox.x1) / 2
  const targetCy = (target.bbox.y0 + target.bbox.y1) / 2

  let closest: SourceRectangle | null = null
  let closestDist = Infinity
  for (const s of all) {
    if (s.id === sourceId) continue
    const cx = (s.bbox.x0 + s.bbox.x1) / 2
    const cy = (s.bbox.y0 + s.bbox.y1) / 2
    // Penalize different pages heavily so same-page neighbors win
    const pagePenalty = s.bbox.page === target.bbox.page ? 0 : 100000
    const dist = Math.hypot(cx - targetCx, cy - targetCy) + pagePenalty
    if (dist < closestDist) {
      closestDist = dist
      closest = s
    }
  }
  if (!closest) return null

  pushHistory(pdfId)

  // Sort target+closest by (page, y0) so text is joined in reading order
  const ordered = [target, closest].sort((a, b) => {
    if (a.bbox.page !== b.bbox.page) return a.bbox.page - b.bbox.page
    return a.bbox.y0 - b.bbox.y0
  })
  const first = ordered[0]
  const second = ordered[1]

  // Build the merged bbox list — group by page, union bboxes per page
  const byPage = new Map<number, { x0: number; y0: number; x1: number; y1: number }>()
  const collectBboxes = (s: SourceRectangle): void => {
    const allBboxes = s.bboxes && s.bboxes.length > 0 ? s.bboxes : [s.bbox]
    for (const bb of allBboxes) {
      const existing = byPage.get(bb.page)
      if (existing) {
        existing.x0 = Math.min(existing.x0, bb.x0)
        existing.y0 = Math.min(existing.y0, bb.y0)
        existing.x1 = Math.max(existing.x1, bb.x1)
        existing.y1 = Math.max(existing.y1, bb.y1)
      } else {
        byPage.set(bb.page, { x0: bb.x0, y0: bb.y0, x1: bb.x1, y1: bb.y1 })
      }
    }
  }
  collectBboxes(first)
  collectBboxes(second)

  const mergedBboxes = Array.from(byPage.entries())
    .sort(([a], [b]) => a - b)
    .map(([page, b]) => ({ ...b, page }))

  const mergedText = `${first.text.trim()} ${second.text.trim()}`.trim()

  const merged: SourceRectangle = {
    ...first,
    bbox: mergedBboxes[0],
    bboxes: mergedBboxes.length > 1 ? mergedBboxes : [],
    text: mergedText,
    status: 'edited',
  }

  useSourcesStore.setState(state => ({
    sourcesByPdf: {
      ...state.sourcesByPdf,
      [pdfId]: (state.sourcesByPdf[pdfId] ?? [])
        .filter(s => s.id !== first.id && s.id !== second.id)
        .concat(merged),
    },
  }))
  renumberSources(pdfId)
  updateSourceCount(pdfId, useSourcesStore.getState().sourcesByPdf[pdfId]?.length ?? 0)

  // Find the new id of the merged source after renumbering
  const renumbered = useSourcesStore.getState().sourcesByPdf[pdfId] ?? []
  const newOne = renumbered.find(s => s.text === mergedText)
  return newOne?.id ?? null
}


export function removeRectangle(pdfId: string, sourceId: string): void {
  pushHistory(pdfId)
  useSourcesStore.setState(state => ({
    sourcesByPdf: {
      ...state.sourcesByPdf,
      [pdfId]: (state.sourcesByPdf[pdfId] ?? []).filter(s => s.id !== sourceId),
    },
  }))
  renumberSources(pdfId)
  updateSourceCount(pdfId, useSourcesStore.getState().sourcesByPdf[pdfId]?.length ?? 0)
}

export function updateRectangle(pdfId: string, sourceId: string, updates: Partial<SourceRectangle>): void {
  pushHistory(pdfId)
  useSourcesStore.setState(state => ({
    sourcesByPdf: {
      ...state.sourcesByPdf,
      [pdfId]: (state.sourcesByPdf[pdfId] ?? []).map(s =>
        s.id === sourceId ? { ...s, ...updates, status: 'edited' as const } : s
      ),
    },
  }))
}

export function beginEdit(pdfId: string): void {
  pushHistory(pdfId)
}

export function updateRectangleSilent(pdfId: string, sourceId: string, updates: Partial<SourceRectangle>): void {
  useSourcesStore.setState(state => ({
    sourcesByPdf: {
      ...state.sourcesByPdf,
      [pdfId]: (state.sourcesByPdf[pdfId] ?? []).map(s =>
        s.id === sourceId ? { ...s, ...updates, status: 'edited' as const } : s
      ),
    },
  }))
}

export function revert(pdfId: string): void {
  useSourcesStore.setState(state => {
    const history = state.historyByPdf[pdfId]
    if (!history || history.length === 0) return state
    const prev = history[history.length - 1]
    return {
      sourcesByPdf: { ...state.sourcesByPdf, [pdfId]: prev },
      historyByPdf: { ...state.historyByPdf, [pdfId]: history.slice(0, -1) },
    }
  })
  updateSourceCount(pdfId, useSourcesStore.getState().sourcesByPdf[pdfId]?.length ?? 0)
}

export function canRevert(pdfId: string): boolean {
  return (useSourcesStore.getState().historyByPdf[pdfId]?.length ?? 0) > 0
}

export async function revertToOriginal(pdfId: string): Promise<void> {
  // Originals were captured the first time sources were set for this PDF
  // (see `setSources`). Use them directly and persist the reverted list to
  // the backend cache so re-imports stay consistent.
  const original = useSourcesStore.getState().originalSourcesByPdf[pdfId]
  if (!original) {
    console.warn(`[revertToOriginal] no original sources stored for ${pdfId}`)
    return
  }
  const cloned = original.map(s => ({ ...s, bbox: { ...s.bbox } }))
  useSourcesStore.setState(state => ({
    sourcesByPdf: { ...state.sourcesByPdf, [pdfId]: cloned },
    historyByPdf: { ...state.historyByPdf, [pdfId]: [] },
  }))
  updateSourceCount(pdfId, cloned.length)
  try {
    await api.updateSources(pdfId, cloned)
  } catch (e) {
    console.error('Failed to persist revert:', e)
  }
}

export async function saveSources(pdfId: string): Promise<void> {
  const sources = useSourcesStore.getState().sourcesByPdf[pdfId]
  if (!sources) {
    // No in-memory state yet — refuse to overwrite backend with an empty list.
    console.warn(`[saveSources] skipped for ${pdfId}: no sources in store`)
    return
  }
  try {
    await api.updateSources(pdfId, sources)
    console.log(`%c[saveSources] ✓ ${pdfId} (${sources.length} sources)`, 'color: #22c55e')
  } catch (e) {
    console.error(`[saveSources] ✗ ${pdfId}:`, e)
    throw e
  }
}

export async function approveSources(pdfId: string): Promise<void> {
  try {
    await api.approvePdf(pdfId)
  } catch (e) {
    console.error('Failed to approve sources:', e)
  }
}

export async function unapproveSources(pdfId: string): Promise<void> {
  try {
    await api.unapprovePdf(pdfId)
    await loadSources(pdfId)
  } catch (e) {
    console.error('Failed to unapprove sources:', e)
  }
}

export async function loadSources(pdfId: string): Promise<void> {
  try {
    const response = await api.getSources(pdfId)
    // Only seed the store when the backend actually had a cache entry.
    // Otherwise we'd overwrite freshly-detected client-side sources with []
    // on the cold path where a PDF is opened before the orchestrator has
    // finished persisting.
    if (response.cached) {
      setSources(pdfId, response.sources)
    }
  } catch (e) {
    console.error('Failed to load sources:', e)
  }
}

export function clearSourcesForPdf(pdfId: string): void {
  useSourcesStore.setState(state => {
    const sourcesByPdf = { ...state.sourcesByPdf }
    const originalSourcesByPdf = { ...state.originalSourcesByPdf }
    const historyByPdf = { ...state.historyByPdf }
    delete sourcesByPdf[pdfId]
    delete originalSourcesByPdf[pdfId]
    delete historyByPdf[pdfId]
    return {
      sourcesByPdf,
      originalSourcesByPdf,
      historyByPdf,
    }
  })
}
