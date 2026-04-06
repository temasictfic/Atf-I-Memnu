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
  try {
    const response = await api.revertPdf(pdfId)
    useSourcesStore.setState(state => ({
      sourcesByPdf: { ...state.sourcesByPdf, [pdfId]: response.sources },
      historyByPdf: { ...state.historyByPdf, [pdfId]: [] },
    }))
    updateSourceCount(pdfId, response.sources.length)
  } catch (e) {
    console.error('Failed to revert:', e)
  }
}

export async function saveSources(pdfId: string): Promise<void> {
  try {
    await api.updateSources(pdfId, useSourcesStore.getState().sourcesByPdf[pdfId] ?? [])
  } catch (e) {
    console.error('Failed to save sources:', e)
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
    setSources(pdfId, response.sources)
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
