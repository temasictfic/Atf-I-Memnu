import { create } from 'zustand'
import type { ScholarQueueItem, ScholarScanStatus } from '../services/scholar-scanner'
import { scholarScanner } from '../services/scholar-scanner'
import { useVerificationStore } from './verification-store'
import { useSourcesStore } from './sources-store'
import { sanitizeReferenceTextForSearch } from '../utils/reference-text'
import { api } from '../api/rest-client'

interface ScholarScanState {
  status: ScholarScanStatus
  queue: ScholarQueueItem[]
  currentIndex: number
  totalInQueue: number
  foundCount: number
  captchaUrl: string | null
  currentSourceId: string | null
  lastDoneSourceId: string | null
  lastDoneUpdated: boolean | null
  closeOverlayFn: (() => void) | null

  startScanForPdf: (pdfId: string) => Promise<void>
  startScanForSource: (pdfId: string, sourceId: string) => Promise<void>
  cancelScan: () => void
  resumeAfterCaptcha: () => void
  setCloseOverlayFn: (fn: (() => void) | null) => void
}

export const useScholarScanStore = create<ScholarScanState>((set, get) => {
  // Wire up scanner callbacks
  scholarScanner.setCallbacks({
    onStatusChange: (status) => set({ status }),
    onProgress: (current, total, foundCount) =>
      set({ currentIndex: current, totalInQueue: total, foundCount }),
    onCaptcha: (url) => set({ captchaUrl: url }),
    onCaptchaResolved: () => {
      const closeFn = useScholarScanStore.getState().closeOverlayFn
      if (closeFn) closeFn()
      set({ captchaUrl: null })
    },
    onError: (_sourceId, _error) => {
      // Errors are non-fatal; scanner continues to next item
    },
    onSourceDone: (sourceId, updated) => {
      set({ currentSourceId: sourceId, lastDoneSourceId: sourceId, lastDoneUpdated: updated })
      // Locally mark "Google Scholar" as searched for this source so the
      // DATABASE RESULTS list updates immediately, independent of any WS
      // broadcast race. The backend's verify_source_done update is still the
      // source of truth for best_match / all_results.
      useVerificationStore.setState((state) => {
        let foundPdfId: string | null = null
        for (const [pdfId, sourceResults] of Object.entries(state.resultsByPdf)) {
          if (sourceResults[sourceId]) {
            foundPdfId = pdfId
            break
          }
        }
        if (!foundPdfId) return state
        const prev = state.resultsByPdf[foundPdfId][sourceId]
        if (prev.databases_searched.includes('Google Scholar')) return state
        return {
          resultsByPdf: {
            ...state.resultsByPdf,
            [foundPdfId]: {
              ...state.resultsByPdf[foundPdfId],
              [sourceId]: {
                ...prev,
                databases_searched: [...prev.databases_searched, 'Google Scholar'],
              },
            },
          },
        }
      })
    },
  })

  // Build the scan queue. Each item's searchText is the NER-extracted title
  // of the reference — the raw sanitized text is only used as a fallback when
  // extraction returns an empty title so the source is not silently skipped.
  async function buildQueue(pdfId: string, sourceIds?: string[]): Promise<ScholarQueueItem[]> {
    const verStore = useVerificationStore.getState()
    const srcStore = useSourcesStore.getState()
    const results = verStore.resultsByPdf[pdfId] ?? {}
    const sources = srcStore.sourcesByPdf[pdfId] ?? []

    const selected = sources.filter((s) => {
      if (sourceIds) return sourceIds.includes(s.id)
      const r = results[s.id]
      return r && (r.status === 'not_found' || r.status === 'problematic')
    })

    return Promise.all(
      selected.map(async (s) => {
        const rawText = verStore.verifyTexts[s.id] ?? s.text
        let searchText = ''
        try {
          const parsed = await api.extractFields(rawText)
          searchText = parsed?.title?.trim() ?? ''
        } catch (err) {
          console.warn(`[Scholar] extractFields failed for ${s.id}:`, err)
        }
        if (!searchText) {
          searchText = sanitizeReferenceTextForSearch(rawText)
        } else {
          searchText = sanitizeReferenceTextForSearch(searchText)
        }
        return { pdfId, sourceId: s.id, searchText }
      }),
    )
  }

  return {
    status: 'idle',
    queue: [],
    currentIndex: 0,
    totalInQueue: 0,
    foundCount: 0,
    captchaUrl: null,
    currentSourceId: null,
    lastDoneSourceId: null,
    lastDoneUpdated: null,
    closeOverlayFn: null,

    startScanForPdf: async (pdfId) => {
      // Show the banner immediately while we build the queue. NER field
      // extraction runs one HTTP call per non-found source, and for PDFs with
      // many references the wait before status flips to 'scanning' is
      // user-visible — so flip it now and let the banner render a
      // "Preparing…" state until the queue is ready.
      set({
        status: 'scanning',
        queue: [],
        totalInQueue: 0,
        currentIndex: 0,
        foundCount: 0,
        captchaUrl: null,
        lastDoneSourceId: null,
        lastDoneUpdated: null,
      })
      const queue = await buildQueue(pdfId)
      if (queue.length === 0) {
        set({ status: 'idle' })
        return
      }
      set({ queue, totalInQueue: queue.length })
      scholarScanner.startScan(queue)
    },

    startScanForSource: async (pdfId, sourceId) => {
      set({
        status: 'scanning',
        queue: [],
        totalInQueue: 0,
        currentIndex: 0,
        foundCount: 0,
        captchaUrl: null,
        lastDoneSourceId: null,
        lastDoneUpdated: null,
      })
      const queue = await buildQueue(pdfId, [sourceId])
      if (queue.length === 0) {
        set({ status: 'idle' })
        return
      }
      set({ queue, totalInQueue: queue.length })
      scholarScanner.startScan(queue)
    },

    cancelScan: () => {
      scholarScanner.cancel()
    },

    resumeAfterCaptcha: () => {
      // console.log('[Scholar] Store: resumeAfterCaptcha triggered')
      set({ captchaUrl: null })
      scholarScanner.resumeAfterCaptcha()
    },

    setCloseOverlayFn: (fn) => set({ closeOverlayFn: fn }),
  }
})
