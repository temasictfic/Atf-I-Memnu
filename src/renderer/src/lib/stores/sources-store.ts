import { create } from 'zustand'
import type { SourceRectangle } from '../api/types'
import { api } from '../api/rest-client'
import { makeSourceId } from '../utils/source-id'
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

/**
 * Demote an approved PDF back to "parsed" when the user edits its
 * rectangles. Unlike `unapproveSources` — which is triggered by the user
 * explicitly clicking the Approved toggle and therefore reloads the cached
 * backend state — this variant does NOT touch the in-memory source list,
 * because the caller has just modified it locally and we would otherwise
 * clobber the edit. Status-only change; the backend unapprove is best-
 * effort in the background.
 */
function autoUnapproveOnEdit(pdfId: string): void {
  const pdf = usePdfStore.getState().pdfs.find(p => p.id === pdfId)
  if (!pdf || pdf.status !== 'approved') return
  usePdfStore.getState().updatePdfStatus(pdfId, 'parsed')
  api.unapprovePdf(pdfId).catch(err => {
    console.warn(`[sources-store] backend unapprove failed for ${pdfId}:`, err)
  })
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
    // IDs are content-addressed: hash(text) keeps entries stable across
    // merge/delete/reorder unless the text itself changes, so verification
    // cache entries stay attached to the right reference. Duplicates in one
    // PDF get `_2`, `_3` appended in reading order — deterministic.
    const seen = new Map<string, number>()
    const renumbered = sorted.map((s, i) => {
      const base = makeSourceId(pdfId, s.text)
      const n = (seen.get(base) ?? 0) + 1
      seen.set(base, n)
      const id = n > 1 ? `${base}_${n}` : base
      return { ...s, ref_number: i + 1, id }
    })
    return { sourcesByPdf: { ...state.sourcesByPdf, [pdfId]: renumbered } }
  })
}

export function getSources(pdfId: string): SourceRectangle[] {
  return useSourcesStore.getState().sourcesByPdf[pdfId] ?? []
}

// Content-addressed IDs collide when two references share identical text
// (e.g. the same URL cited twice). renumberSources dedupes with _2/_3 but
// only runs on edits — fresh detection and backend loads skip it, so the
// collision leaks into sourceOrder and React keys. Suffix-dedupe here so
// every path through setSources produces unique IDs.
function ensureUniqueSourceIds(sources: SourceRectangle[]): SourceRectangle[] {
  const used = new Set<string>()
  let changed = false
  const out = sources.map(s => {
    if (!used.has(s.id)) {
      used.add(s.id)
      return s
    }
    changed = true
    let n = 2
    let candidate = `${s.id}_${n}`
    while (used.has(candidate)) {
      n++
      candidate = `${s.id}_${n}`
    }
    used.add(candidate)
    return { ...s, id: candidate }
  })
  return changed ? out : sources
}

export function setSources(pdfId: string, sources: SourceRectangle[]): void {
  const unique = ensureUniqueSourceIds(sources)
  useSourcesStore.setState(state => ({
    sourcesByPdf: { ...state.sourcesByPdf, [pdfId]: unique },
    originalSourcesByPdf: state.originalSourcesByPdf[pdfId]
      ? state.originalSourcesByPdf
      : { ...state.originalSourcesByPdf, [pdfId]: [...unique] },
  }))
  updateSourceCount(pdfId, unique.length)
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
  autoUnapproveOnEdit(pdfId)
}

/**
 * Merge two source rectangles by id. Joins their text in reading order
 * (sorted by page then y0), unions bboxes per page, renumbers the list,
 * and returns the id of the resulting merged source.
 */
function mergeTwo(pdfId: string, aId: string, bId: string): string | null {
  const all = useSourcesStore.getState().sourcesByPdf[pdfId] ?? []
  const a = all.find(s => s.id === aId)
  const b = all.find(s => s.id === bId)
  if (!a || !b || a.id === b.id) return null

  pushHistory(pdfId)

  // Sort the pair by (page, y0) so text is joined in reading order
  const ordered = [a, b].sort((x, y) => {
    if (x.bbox.page !== y.bbox.page) return x.bbox.page - y.bbox.page
    return x.bbox.y0 - y.bbox.y0
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
    .sort(([p1], [p2]) => p1 - p2)
    .map(([page, bb]) => ({ ...bb, page }))

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
  autoUnapproveOnEdit(pdfId)

  // Find the new id of the merged source after renumbering
  const renumbered = useSourcesStore.getState().sourcesByPdf[pdfId] ?? []
  const newOne = renumbered.find(s => s.text === mergedText)
  return newOne?.id ?? null
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

  return mergeTwo(pdfId, target.id, closest.id)
}

/**
 * Merge a source rectangle with the one immediately preceding it in reading
 * order (ref_number - 1). The merged result inherits the previous source's
 * number, so the selected box does not introduce a new reference. Returns
 * the id of the resulting merged source, or null if there is no previous.
 */
export function mergeWithPrevious(pdfId: string, sourceId: string): string | null {
  const all = useSourcesStore.getState().sourcesByPdf[pdfId] ?? []
  const target = all.find(s => s.id === sourceId)
  if (!target || target.ref_number == null) return null
  const prevNumber = target.ref_number - 1
  const prev = all.find(s => s.ref_number === prevNumber)
  if (!prev) return null
  return mergeTwo(pdfId, target.id, prev.id)
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
  autoUnapproveOnEdit(pdfId)
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
  // Text edits produce a new content-hash ID; let renumberSources rehash
  // and dedup. Bbox/status-only updates stay stable.
  if (updates.text !== undefined) {
    renumberSources(pdfId)
  }
  autoUnapproveOnEdit(pdfId)
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
  autoUnapproveOnEdit(pdfId)
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
  autoUnapproveOnEdit(pdfId)
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
  autoUnapproveOnEdit(pdfId)
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
    // console.log(`%c[saveSources] ✓ ${pdfId} (${sources.length} sources)`, 'color: #22c55e')
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
