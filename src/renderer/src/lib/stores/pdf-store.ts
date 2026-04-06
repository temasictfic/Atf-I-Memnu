import { create } from 'zustand'
import type { PdfDocument } from '../api/types'
import { api } from '../api/rest-client'
import { wsClient } from '../api/ws-client'

type ParsingSortKey = 'name' | 'status' | 'count'

interface PdfState {
  pdfs: PdfDocument[]
  selectedPdfId: string | null
  loading: boolean
  parsingSortKey: ParsingSortKey
  parsingSortAsc: boolean
  selectPdf: (id: string | null) => void
  toggleParsingSort: (key: ParsingSortKey) => void
  addPdf: (pdf: PdfDocument) => void
  removePdf: (pdfId: string) => void
  updatePdfStatus: (pdfId: string, status: PdfDocument['status'], sourceCount?: number) => void
  updateSourceCount: (pdfId: string, count: number) => void
  loadDirectory: (directory: string) => Promise<void>
  loadFiles: (filePaths: string[]) => Promise<void>
  clearPdfs: () => void
}

let pollIntervalId: ReturnType<typeof setInterval> | null = null

function stopPolling(): void {
  if (pollIntervalId) {
    clearInterval(pollIntervalId)
    pollIntervalId = null
  }
}

function startPollingFallback(jobId: string): void {
  stopPolling()
  pollIntervalId = setInterval(async () => {
    try {
      const status = await api.parseStatus(jobId)
      const { pdfs } = usePdfStore.getState()
      let allDone = true

      for (const pdf of status.pdfs) {
        const existing = pdfs.find(p => p.id === pdf.id)
        if (!existing) {
          usePdfStore.getState().addPdf({
            id: pdf.id,
            name: pdf.name,
            path: '',
            status: pdf.status as PdfDocument['status'],
            source_count: pdf.source_count ?? 0,
          })
        } else if (existing.status !== pdf.status || existing.source_count !== (pdf.source_count ?? 0)) {
          usePdfStore.getState().updatePdfStatus(pdf.id, pdf.status as PdfDocument['status'], pdf.source_count)
        }
        if (pdf.status !== 'parsed' && pdf.status !== 'error' && pdf.status !== 'approved') {
          allDone = false
        }
      }
      if (allDone && status.pdfs.length > 0) {
        usePdfStore.setState({ loading: false })
        stopPolling()
      }
    } catch (e) {
      console.error('Polling fallback failed:', e)
    }
  }, 3000)
}

export const usePdfStore = create<PdfState>()((set, get) => ({
  pdfs: [],
  selectedPdfId: null,
  loading: false,
  parsingSortKey: 'name' as ParsingSortKey,
  parsingSortAsc: true,

  selectPdf: (id) => set({ selectedPdfId: id }),

  toggleParsingSort: (key) =>
    set(state => {
      if (state.parsingSortKey === key) return { parsingSortAsc: !state.parsingSortAsc }
      return { parsingSortKey: key, parsingSortAsc: true }
    }),

  addPdf: (pdf) =>
    set(state => ({
      pdfs: state.pdfs.some(p => p.id === pdf.id) ? state.pdfs : [...state.pdfs, pdf],
    })),

  removePdf: (pdfId) =>
    set(state => {
      const remaining = state.pdfs.filter(p => p.id !== pdfId)
      let nextSelectedPdfId = state.selectedPdfId

      if (state.selectedPdfId === pdfId) {
        if (remaining.length === 0) {
          nextSelectedPdfId = null
        } else {
          const removedIndex = state.pdfs.findIndex(p => p.id === pdfId)
          const fallbackIndex = Math.min(Math.max(removedIndex, 0), remaining.length - 1)
          nextSelectedPdfId = remaining[fallbackIndex]?.id ?? null
        }
      }

      return {
        pdfs: remaining,
        selectedPdfId: nextSelectedPdfId,
      }
    }),

  updatePdfStatus: (pdfId, status, sourceCount) =>
    set(state => ({
      pdfs: state.pdfs.map(p =>
        p.id === pdfId ? { ...p, status, source_count: sourceCount ?? p.source_count } : p
      ),
    })),

  updateSourceCount: (pdfId, count) =>
    set(state => ({
      pdfs: state.pdfs.map(p => (p.id === pdfId ? { ...p, source_count: count } : p)),
    })),

  loadDirectory: async (directory) => {
    set({ loading: true })
    try {
      const response = await api.parseDirectory(directory)
      startPollingFallback(response.job_id)
    } catch (e) {
      console.error('Failed to start parsing:', e)
      set({ loading: false })
    }
  },

  loadFiles: async (filePaths) => {
    set({ loading: true })
    try {
      const response = await api.parseFiles(filePaths)
      startPollingFallback(response.job_id)
    } catch (e) {
      console.error('Failed to start parsing:', e)
      set({ loading: false })
    }
  },

  clearPdfs: () => {
    stopPolling()
    set({ pdfs: [], selectedPdfId: null, loading: false })
  },
}))

// --- Buffered parse console logging ---

interface ParseLogEntry {
  pdfName: string
  sourceCount: number
  fromCache: string | null
  error?: string
}

const parseBuffer: ParseLogEntry[] = []

function flushParseLog(): void {
  if (parseBuffer.length === 0) return

  const totalSources = parseBuffer.reduce((sum, e) => sum + e.sourceCount, 0)
  const allCached = parseBuffer.every(e => e.fromCache !== null && !e.error)

  const label = allCached
    ? `[Loaded Parsed Cache] ${totalSources}`
    : `[Parsed] ${totalSources}`
  const labelColor = allCached ? 'color: #60a5fa; font-weight: bold' : 'color: #a78bfa; font-weight: bold'

  console.group(`%c${label}`, labelColor)

  for (const entry of parseBuffer) {
    if (entry.error) {
      console.groupCollapsed(`%c${entry.pdfName}`, 'color: #ef4444')
      console.log(`%c\u2715 Parse error: ${entry.error}`, 'color: #ef4444')
      console.groupEnd()
    } else if (entry.fromCache) {
      console.log(`%c${entry.pdfName}`, 'color: #a8a29e')
    } else {
      console.groupCollapsed(`%c${entry.pdfName}`, 'color: #22c55e')
      console.log(`%c\u2713 ${entry.sourceCount} sources detected`, 'color: #22c55e')
      console.groupEnd()
    }
  }

  console.groupEnd()
  parseBuffer.length = 0
}

// --- Listeners ---

export function initPdfListeners(): () => void {
  const unsubs = [
    wsClient.on('parse_started', (data) => {
      usePdfStore.getState().addPdf({
        id: data.pdf_id as string,
        name: data.pdf_name as string,
        path: '',
        status: 'parsing',
        source_count: 0,
      })
    }),
    wsClient.on('parse_progress', (data) => {
      usePdfStore.getState().updatePdfStatus(data.pdf_id as string, 'parsing')
    }),
    wsClient.on('parse_complete', (data) => {
      parseBuffer.push({
        pdfName: data.pdf_name as string,
        sourceCount: data.source_count as number,
        fromCache: (data.from_cache as string) ?? null,
      })
      usePdfStore.getState().updatePdfStatus(data.pdf_id as string, 'parsed', data.source_count as number)
    }),
    wsClient.on('parse_error', (data) => {
      parseBuffer.push({
        pdfName: (data.pdf_name as string) ?? (data.pdf_id as string),
        sourceCount: 0,
        fromCache: null,
        error: data.error as string,
      })
      usePdfStore.getState().updatePdfStatus(data.pdf_id as string, 'error')
    }),
    wsClient.on('parse_approved', (data) => {
      usePdfStore.getState().updatePdfStatus(data.pdf_id as string, 'approved')
    }),
    wsClient.on('parse_unapproved', (data) => {
      usePdfStore.getState().updatePdfStatus(data.pdf_id as string, 'parsed')
    }),
    wsClient.on('parse_all_done', () => {
      usePdfStore.setState({ loading: false })
      stopPolling()
      flushParseLog()
    }),
  ]

  return () => {
    unsubs.forEach(fn => fn())
    stopPolling()
  }
}
