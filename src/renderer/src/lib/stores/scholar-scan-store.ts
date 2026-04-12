import { create } from 'zustand'
import type { ScholarQueueItem, ScholarScanStatus } from '../services/scholar-scanner'
import { scholarScanner } from '../services/scholar-scanner'
import { useVerificationStore } from './verification-store'
import { useSourcesStore } from './sources-store'
import { sanitizeReferenceTextForSearch } from '../utils/reference-text'

interface ScholarScanState {
  status: ScholarScanStatus
  queue: ScholarQueueItem[]
  currentIndex: number
  totalInQueue: number
  foundCount: number
  captchaUrl: string | null
  currentSourceId: string | null
  closeOverlayFn: (() => void) | null

  startScanForPdf: (pdfId: string) => void
  startScanForSource: (pdfId: string, sourceId: string) => void
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
    onSourceDone: (sourceId, _updated) => set({ currentSourceId: sourceId }),
  })

  function buildQueue(pdfId: string, sourceIds?: string[]): ScholarQueueItem[] {
    const verStore = useVerificationStore.getState()
    const srcStore = useSourcesStore.getState()
    const results = verStore.resultsByPdf[pdfId] ?? {}
    const sources = srcStore.sourcesByPdf[pdfId] ?? []

    return sources
      .filter((s) => {
        if (sourceIds) return sourceIds.includes(s.id)
        const r = results[s.id]
        return r && (r.status === 'not_found' || r.status === 'problematic')
      })
      .map((s) => ({
        pdfId,
        sourceId: s.id,
        searchText: sanitizeReferenceTextForSearch(
          verStore.verifyTexts[s.id] ?? s.text,
        ),
      }))
  }

  return {
    status: 'idle',
    queue: [],
    currentIndex: 0,
    totalInQueue: 0,
    foundCount: 0,
    captchaUrl: null,
    currentSourceId: null,
    closeOverlayFn: null,

    startScanForPdf: (pdfId) => {
      const queue = buildQueue(pdfId)
      if (queue.length === 0) return
      set({ queue, totalInQueue: queue.length, currentIndex: 0, foundCount: 0, captchaUrl: null })
      scholarScanner.startScan(queue)
    },

    startScanForSource: (pdfId, sourceId) => {
      const queue = buildQueue(pdfId, [sourceId])
      if (queue.length === 0) return
      set({ queue, totalInQueue: queue.length, currentIndex: 0, foundCount: 0, captchaUrl: null })
      scholarScanner.startScan(queue)
    },

    cancelScan: () => {
      scholarScanner.cancel()
    },

    resumeAfterCaptcha: () => {
      console.log('[Scholar] Store: resumeAfterCaptcha triggered')
      set({ captchaUrl: null })
      scholarScanner.resumeAfterCaptcha()
    },

    setCloseOverlayFn: (fn) => set({ closeOverlayFn: fn }),
  }
})
