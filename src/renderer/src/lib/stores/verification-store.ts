import { create } from 'zustand'
import type {
  VerificationResult, PdfVerificationSummary, VerifyStatus,
  SourceRectangle, SourceVerifyProgress, DbCheckStatus, DbCheckEntry,
} from '../api/types'
import { api } from '../api/rest-client'
import { wsClient } from '../api/ws-client'
import { sanitizeReferenceText } from '../utils/reference-text'
import { usePdfStore } from './pdf-store'

type CardSortKey = 'default' | 'status' | 'ref' | 'enabled'
type PdfSortKey = 'name' | 'status' | 'found' | 'problematic' | 'not_found'

interface VerificationState {
  resultsByPdf: Record<string, Record<string, VerificationResult>>
  summaries: Record<string, PdfVerificationSummary>
  sourceProgress: Record<string, SourceVerifyProgress>
  selectedSourceId: string | null
  verifyTexts: Record<string, string>
  sourceOriginalTexts: Record<string, string>
  enabledSources: Record<string, boolean>
  sourceOrder: Record<string, string[]>
  cardSortKey: CardSortKey
  cardSortAsc: boolean
  pdfSortKey: PdfSortKey
  pdfSortAsc: boolean

  selectSource: (id: string | null) => void
  setVerifyText: (sourceId: string, text: string) => void
  resetVerifyText: (sourceId: string) => void
  toggleSourceEnabled: (sourceId: string) => void
  setAllEnabled: (pdfId: string, enabled: boolean) => void
  reorderSources: (pdfId: string, fromIndex: number, toIndex: number) => void
  toggleCardSort: (key: CardSortKey) => void
  togglePdfSort: (key: PdfSortKey) => void
  initSourceVerifyState: (pdfId: string, sources: SourceRectangle[]) => void
  startVerification: (pdfIds: string[]) => Promise<void>
  startVerificationNonFoundForPdf: (pdfId: string) => Promise<void>
  reverifySource: (pdfId: string, sourceId: string, text?: string) => Promise<void>
  reverifyPdf: (pdfId: string) => Promise<void>
  overrideStatus: (pdfId: string, sourceId: string, status: 'found' | 'problematic' | 'not_found') => Promise<void>
  cancelAll: () => Promise<void>
  cancelPdf: (pdfId: string) => Promise<void>
  cancelSource: (sourceId: string) => Promise<void>
  loadResults: (pdfId: string) => Promise<void>
}

let pollingTimer: ReturnType<typeof setInterval> | null = null
let pollingPdfIds: string[] = []

function stopPolling(): void {
  if (pollingTimer) {
    clearInterval(pollingTimer)
    pollingTimer = null
  }
  pollingPdfIds = []
}

function startPolling(pdfIds: string[], jobId: string): void {
  stopPolling()
  pollingPdfIds = pdfIds

  pollingTimer = setInterval(async () => {
    // Skip if polling was stopped between ticks
    if (!pollingTimer) return
    try {
      // Check local state first — WS events may have already completed everything
      const localState = useVerificationStore.getState()
      const localDone = pollingPdfIds.every(pdfId => {
        const pdfResults = localState.resultsByPdf[pdfId] ?? {}
        const vals = Object.values(pdfResults)
        return vals.length > 0 && vals.every(r => r.status !== 'in_progress')
      })
      if (localDone) {
        // Mark summaries as completed and stop
        useVerificationStore.setState(state => {
          const next = { ...state.summaries }
          for (const pdfId of pollingPdfIds) {
            if (next[pdfId] && !next[pdfId].completed) {
              next[pdfId] = { ...next[pdfId], in_progress: 0, completed: true }
            }
          }
          return { summaries: next }
        })
        stopPolling()
        return
      }

      const statusResp = await api.verifyStatus(jobId)
      useVerificationStore.setState(state => {
        const next = { ...state.summaries }
        for (const s of statusResp.pdfs) {
          next[s.pdf_id] = { ...s }
        }
        return { summaries: next }
      })

      for (const pdfId of pollingPdfIds) {
        try {
          const resultResp = await api.verifyResults(pdfId)
          const newResults = resultResp.results
          const prevResults = useVerificationStore.getState().resultsByPdf[pdfId] ?? {}

          const newKeys = Object.keys(newResults)
          const prevKeys = Object.keys(prevResults)
          const hasChanges =
            newKeys.length !== prevKeys.length ||
            newKeys.some(k => {
              const n = newResults[k]
              const p = prevResults[k]
              return !p || n.status !== p.status
            })

          if (hasChanges) {
            useVerificationStore.setState(state => ({
              resultsByPdf: { ...state.resultsByPdf, [pdfId]: newResults },
            }))
          }
        } catch {
          // Individual PDF result fetch failed, skip
        }
      }

      const allDone = statusResp.pdfs.length > 0 && statusResp.pdfs.every(s => s.completed)
      if (allDone) stopPolling()
    } catch (e) {
      console.error('[Poll] Polling error:', e)
    }
  }, 5000)
}

// --- Buffered verification console logging ---

interface DbCheckLog {
  database: string
  dbStatus: DbCheckStatus
  match: Record<string, unknown> | null
  searchUrl: string
}

interface SourceLog {
  sourceId: string
  sourceText: string
  dbChecks: DbCheckLog[]
  finalStatus: string | null
}

interface PdfVerifyLog {
  pdfId: string
  sources: Map<string, SourceLog>
}

interface VerifyBatch {
  totalSources: number
  pdfs: Map<string, PdfVerifyLog>
  expectedPdfCount: number
  completedPdfs: number
  groupOpened: boolean
}

let verifyBatch: VerifyBatch | null = null

function initVerifyBatch(totalSources: number, pdfCount: number): void {
  // Flush any leftover batch
  if (verifyBatch?.groupOpened) {
    console.groupEnd()
  }
  verifyBatch = {
    totalSources,
    pdfs: new Map(),
    expectedPdfCount: pdfCount,
    completedPdfs: 0,
    groupOpened: false,
  }
}

function flushPdfVerifyLog(pdfId: string): void {
  if (!verifyBatch) return
  const pdfLog = verifyBatch.pdfs.get(pdfId)
  if (!pdfLog) return

  // Resolve PDF name from store
  const pdf = usePdfStore.getState().pdfs.find(p => p.id === pdfId)
  const pdfName = pdf?.name ?? pdfId

  console.groupCollapsed(`%c${pdfName}`, 'color: #e2e8f0; font-weight: bold')

  for (const [, sourceLog] of pdfLog.sources) {
    const statusColors: Record<string, string> = {
      found: '#22c55e', problematic: '#f59e0b', not_found: '#9ca3af',
    }
    const statusColor = statusColors[sourceLog.finalStatus ?? ''] ?? '#a8a29e'
    const statusLabel = (sourceLog.finalStatus ?? 'unknown').toUpperCase()

    console.groupCollapsed(
      `%c${sourceLog.sourceId} %c[${statusLabel}]`,
      'color: #e2e8f0',
      `color: ${statusColor}; font-weight: bold`,
    )

    for (const dbCheck of sourceLog.dbChecks) {
      // Build summary for the database group label
      const queryLabels: Record<string, string> = {
        found: 'successful', not_found: 'successful', timeout: 'failed (timeout)',
        error: 'failed',
      }
      const queryLabel = queryLabels[dbCheck.dbStatus] ?? dbCheck.dbStatus
      const isFound = dbCheck.dbStatus === 'found' && dbCheck.match
      const score = isFound ? ((dbCheck.match as Record<string, unknown>).score as number) ?? 0 : 0
      const matchLabel = isFound
        ? (score >= 0.65 ? 'Match' : 'Partial Match')
        : (dbCheck.dbStatus === 'not_found' ? 'Not Found' : '')

      const dbColor = '#38bdf8'
      const queryColors: Record<string, string> = {
        found: '#22c55e', not_found: '#22c55e', timeout: '#ef4444',
        error: '#ef4444',
      }
      const qColor = queryColors[dbCheck.dbStatus] ?? '#a8a29e'
      const matchColors: Record<string, string> = { Match: '#22c55e', 'Partial Match': '#eab308', 'Not Found': '#111827' }
      const mColor = matchColors[matchLabel] ?? '#a8a29e'

      // Database group header shows: "Crossref  | successful | Match"
      if (isFound) {
        console.groupCollapsed(
          `%c${dbCheck.database}  %c${queryLabel}  %c${matchLabel}`,
          `color: ${dbColor}; font-weight: bold`,
          `color: ${qColor}`,
          `color: ${mColor}; font-weight: bold`,
        )
        console.log('%cFound Object:', 'color: #22c55e; font-weight: bold')
        console.dir(JSON.parse(JSON.stringify(dbCheck.match)))
        if (dbCheck.searchUrl) {
          console.log('%csearch_url: %s', 'color: #a8a29e', dbCheck.searchUrl)
        }
        console.groupEnd()
      } else {
        // No match — show as single collapsed line with search_url inside
        console.groupCollapsed(
          `%c${dbCheck.database}  %c${queryLabel}  %c${matchLabel}`,
          `color: ${dbColor}; font-weight: bold`,
          `color: ${qColor}`,
          `color: ${mColor}`,
        )
        if (dbCheck.searchUrl) {
          console.log(dbCheck.searchUrl)
        }
        console.groupEnd()
      }
    }

    console.groupEnd() // source
  }

  console.groupEnd() // PDF
}

// --- Store ---

export const useVerificationStore = create<VerificationState>()((set, get) => ({
  resultsByPdf: {},
  summaries: {},
  sourceProgress: {},
  selectedSourceId: null,
  verifyTexts: {},
  sourceOriginalTexts: {},
  enabledSources: {},
  sourceOrder: {},
  cardSortKey: 'default' as CardSortKey,
  cardSortAsc: true,
  pdfSortKey: 'name' as PdfSortKey,
  pdfSortAsc: true,

  selectSource: (id) => set({ selectedSourceId: id }),

  setVerifyText: (sourceId, text) =>
    set(state => ({ verifyTexts: { ...state.verifyTexts, [sourceId]: text } })),

  resetVerifyText: (sourceId) =>
    set(state => ({
      verifyTexts: {
        ...state.verifyTexts,
        [sourceId]: state.sourceOriginalTexts[sourceId] ?? '',
      },
    })),

  toggleSourceEnabled: (sourceId) =>
    set(state => ({
      enabledSources: {
        ...state.enabledSources,
        [sourceId]: !(state.enabledSources[sourceId] ?? true),
      },
    })),

  setAllEnabled: (pdfId, enabled) =>
    set(state => {
      const order = state.sourceOrder[pdfId] ?? []
      const updated = { ...state.enabledSources }
      for (const id of order) updated[id] = enabled
      return { enabledSources: updated }
    }),

  reorderSources: (pdfId, fromIndex, toIndex) =>
    set(state => {
      const order = [...(state.sourceOrder[pdfId] ?? [])]
      const [moved] = order.splice(fromIndex, 1)
      order.splice(toIndex, 0, moved)
      return { sourceOrder: { ...state.sourceOrder, [pdfId]: order } }
    }),

  toggleCardSort: (key) =>
    set(state => {
      if (state.cardSortKey === key) return { cardSortAsc: !state.cardSortAsc }
      return { cardSortKey: key, cardSortAsc: true }
    }),

  togglePdfSort: (key) =>
    set(state => {
      if (state.pdfSortKey === key) return { pdfSortAsc: !state.pdfSortAsc }
      return { pdfSortKey: key, pdfSortAsc: true }
    }),

  initSourceVerifyState: (pdfId, sources) =>
    set(state => {
      const texts = { ...state.verifyTexts }
      const originals = { ...state.sourceOriginalTexts }
      const enabled = { ...state.enabledSources }
      const currentSourceIds = new Set(sources.map(s => s.id))

      for (const source of sources) {
        const cleanedSourceText = sanitizeReferenceText(source.text)
        const prevOriginal = originals[source.id]
        const currentText = texts[source.id]

        if (prevOriginal === undefined) {
          // New source — initialize both
          texts[source.id] = cleanedSourceText
        } else if (currentText === prevOriginal) {
          // User hasn't edited — sync from parsing page
          texts[source.id] = cleanedSourceText
        }
        // else: user has edited (currentText !== prevOriginal) — keep user's edit

        // Always update original to latest parsing text
        originals[source.id] = cleanedSourceText

        if (!(source.id in enabled)) enabled[source.id] = true
      }

      // Clean up stale entries for sources that no longer exist
      const prevOrder = state.sourceOrder[pdfId] ?? []
      for (const oldId of prevOrder) {
        if (!currentSourceIds.has(oldId)) {
          delete texts[oldId]
          delete originals[oldId]
          delete enabled[oldId]
        }
      }

      // Detect if source IDs changed (add/delete causes renumbering)
      const prevOrderSet = new Set(prevOrder)
      const idsChanged = currentSourceIds.size !== prevOrderSet.size
        || [...currentSourceIds].some(id => !prevOrderSet.has(id))

      // If IDs shifted, clear verify results — they'd map to wrong sources
      // If IDs are the same, check for text changes and clear affected entries
      let updatedResults = state.resultsByPdf
      const pdfResults = state.resultsByPdf[pdfId]
      if (pdfResults) {
        if (idsChanged) {
          updatedResults = { ...state.resultsByPdf, [pdfId]: {} }
        } else {
          // Keep results only for sources whose text hasn't changed
          const cleaned: Record<string, VerificationResult> = {}
          for (const source of sources) {
            const prevOrig = state.sourceOriginalTexts[source.id]
            const cleanedSourceText = sanitizeReferenceText(source.text)
            if (pdfResults[source.id] && prevOrig === cleanedSourceText) {
              cleaned[source.id] = pdfResults[source.id]
            }
          }
          if (Object.keys(cleaned).length !== Object.keys(pdfResults).length) {
            updatedResults = { ...state.resultsByPdf, [pdfId]: cleaned }
          }
        }
      }

      const order = sources.map(s => s.id)

      // Recompute summary if results changed
      let updatedSummaries = state.summaries
      if (updatedResults !== state.resultsByPdf) {
        const results = updatedResults[pdfId] ?? {}
        const count = Object.keys(results).length
        let found = 0, problematic = 0, not_found = 0
        for (const r of Object.values(results)) {
          if (r.status === 'found') found++
          else if (r.status === 'problematic') problematic++
          else if (r.status === 'not_found') not_found++
        }
        updatedSummaries = {
          ...state.summaries,
          [pdfId]: {
            pdf_id: pdfId, found, problematic, not_found,
            in_progress: 0, total: count, completed: count > 0,
          },
        }
      }

      return {
        verifyTexts: texts,
        sourceOriginalTexts: originals,
        enabledSources: enabled,
        sourceOrder: { ...state.sourceOrder, [pdfId]: order },
        resultsByPdf: updatedResults,
        summaries: updatedSummaries,
      }
    }),

  startVerification: async (pdfIds) => {
    try {
      const { verifyTexts, enabledSources, sourceOrder } = get()
      const texts: Record<string, string> = {}
      for (const [sourceId, text] of Object.entries(verifyTexts)) {
        texts[sourceId] = sanitizeReferenceText(text)
      }
      const excludedIds = Object.entries(enabledSources)
        .filter(([, enabled]) => !enabled)
        .map(([id]) => id)

      // Count total enabled sources for logging
      const excludedSet = new Set(excludedIds)
      let totalEnabled = 0
      for (const pdfId of pdfIds) {
        const order = sourceOrder[pdfId] ?? []
        for (const sourceId of order) {
          if (!excludedSet.has(sourceId) && enabledSources[sourceId] !== false) {
            totalEnabled++
          }
        }
      }

      // Initialize verify log batch
      initVerifyBatch(totalEnabled, pdfIds.length)

      // Clear progress and summaries BEFORE the API call so we don't
      // race with WebSocket events that arrive during the await.
      // Also eagerly create sourceProgress + in_progress results for all
      // enabled sources so dots appear immediately.
      set(state => {
        const summaries = { ...state.summaries }
        const newProgress: Record<string, { currentDb: string | null; checkedDbs: DbCheckEntry[] }> = {}
        const newResults: Record<string, Record<string, VerificationResult>> = { ...state.resultsByPdf }
        for (const id of pdfIds) {
          summaries[id] = {
            pdf_id: id, found: 0, problematic: 0, not_found: 0,
            in_progress: 0, total: 0, completed: false,
          }
          // Create progress + in_progress result for each enabled source
          const order = state.sourceOrder[id] ?? []
          newResults[id] = {}
          for (const sourceId of order) {
            if (excludedSet.has(sourceId)) continue
            if (state.enabledSources[sourceId] === false) continue
            newProgress[sourceId] = { currentDb: null, checkedDbs: [] }
            newResults[id][sourceId] = {
              source_id: sourceId,
              status: 'in_progress' as VerifyStatus,
              problem_tags: [],
              url_liveness: {},
              all_results: [],
              databases_searched: [],
            }
          }
        }
        return { summaries, sourceProgress: newProgress, resultsByPdf: newResults }
      })

      const response = await api.verifyBatch(pdfIds, texts, excludedIds)

      startPolling(pdfIds, response.job_id)
    } catch (e) {
      console.error('Failed to start verification:', e)
    }
  },

  startVerificationNonFoundForPdf: async (pdfId) => {
    try {
      const { verifyTexts, enabledSources, sourceOrder, resultsByPdf } = get()
      const texts: Record<string, string> = {}
      for (const [sourceId, text] of Object.entries(verifyTexts)) {
        texts[sourceId] = sanitizeReferenceText(text)
      }

      const orderedIds = sourceOrder[pdfId] ?? []
      const knownResultIds = Object.keys(resultsByPdf[pdfId] ?? {})
      const sourceIds = orderedIds.length > 0
        ? orderedIds
        : knownResultIds

      if (sourceIds.length === 0) return

      const includeIds = sourceIds.filter(sourceId => {
        if (enabledSources[sourceId] === false) return false
        const result = resultsByPdf[pdfId]?.[sourceId]
        return result?.status !== 'found'
      })

      if (includeIds.length === 0) return

      const includeSet = new Set(includeIds)
      const excludedIds = sourceIds.filter(sourceId => !includeSet.has(sourceId))

      // Initialize verify log batch for this targeted run.
      initVerifyBatch(includeIds.length, 1)

      set(state => {
        const pdfResults = { ...(state.resultsByPdf[pdfId] ?? {}) }
        const sourceProgress = { ...state.sourceProgress }

        for (const sourceId of includeIds) {
          pdfResults[sourceId] = {
            source_id: sourceId,
            status: 'in_progress' as VerifyStatus,
            problem_tags: [],
            url_liveness: {},
            all_results: [],
            databases_searched: [],
          }
          sourceProgress[sourceId] = { currentDb: null, checkedDbs: [] }
        }

        let found = 0, problematic = 0, not_found = 0, inProgress = 0
        for (const r of Object.values(pdfResults)) {
          if (r.status === 'found') found++
          else if (r.status === 'problematic') problematic++
          else if (r.status === 'not_found') not_found++
          else if (r.status === 'in_progress') inProgress++
        }

        return {
          resultsByPdf: {
            ...state.resultsByPdf,
            [pdfId]: pdfResults,
          },
          sourceProgress,
          summaries: {
            ...state.summaries,
            [pdfId]: {
              pdf_id: pdfId,
              found,
              problematic,
              not_found,
              in_progress: inProgress,
              total: Object.keys(pdfResults).length,
              completed: false,
            },
          },
        }
      })

      const response = await api.verifyBatch([pdfId], texts, excludedIds)
      startPolling([pdfId], response.job_id)
    } catch (e) {
      console.error('Failed to start non-found PDF verification:', e)
    }
  },

  reverifySource: async (pdfId, sourceId, text) => {
    try {
      // Init a mini batch for single verify logging
      initVerifyBatch(1, 1)

      set(state => ({
        resultsByPdf: {
          ...state.resultsByPdf,
          [pdfId]: {
            ...(state.resultsByPdf[pdfId] ?? {}),
            [sourceId]: {
              source_id: sourceId,
              status: 'in_progress' as VerifyStatus,
              problem_tags: [],
              url_liveness: {},
              all_results: [],
              databases_searched: [],
            },
          },
        },
        sourceProgress: {
          ...state.sourceProgress,
          [sourceId]: { currentDb: null, checkedDbs: [] },
        },
      }))
      await api.verifySource(pdfId, sourceId, sanitizeReferenceText(text ?? ''))
    } catch (e) {
      console.error('Failed to verify source:', e)
    }
  },

  reverifyPdf: async (pdfId) => {
    try {
      await api.verifyPdf(pdfId)
    } catch (e) {
      console.error('Failed to verify PDF:', e)
    }
  },

  overrideStatus: async (pdfId, sourceId, status) => {
    try {
      await api.overrideStatus(pdfId, sourceId, status)
      set(state => {
        const prev = state.resultsByPdf[pdfId]?.[sourceId]
        if (!prev) return state
        return {
          resultsByPdf: {
            ...state.resultsByPdf,
            [pdfId]: {
              ...state.resultsByPdf[pdfId],
              [sourceId]: { ...prev, status },
            },
          },
        }
      })
    } catch (e) {
      console.error('Failed to override status:', e)
    }
  },

  cancelAll: async () => {
    stopPolling()
    set(state => {
      const newResults = { ...state.resultsByPdf }
      const newSummaries = { ...state.summaries }
      const newProgress = { ...state.sourceProgress }
      for (const pdfId of Object.keys(newResults)) {
        const pdfResults = { ...newResults[pdfId] }
        let changed = false
        for (const sourceId of Object.keys(pdfResults)) {
          if (pdfResults[sourceId].status === 'in_progress') {
            pdfResults[sourceId] = { ...pdfResults[sourceId], status: 'not_found' as VerifyStatus }
            newProgress[sourceId] = { currentDb: null, checkedDbs: newProgress[sourceId]?.checkedDbs ?? [] }
            changed = true
          }
        }
        if (changed) {
          newResults[pdfId] = pdfResults
          let found = 0, problematic = 0, not_found = 0
          for (const r of Object.values(pdfResults)) {
            if (r.status === 'found') found++
            else if (r.status === 'problematic') problematic++
            else if (r.status === 'not_found') not_found++
          }
          newSummaries[pdfId] = { pdf_id: pdfId, found, problematic, not_found, in_progress: 0, total: Object.keys(pdfResults).length, completed: true }
        }
      }
      return { resultsByPdf: newResults, summaries: newSummaries, sourceProgress: newProgress }
    })
    if (verifyBatch?.groupOpened) console.groupEnd()
    verifyBatch = null
    try { await api.cancelVerification() } catch (e) { console.error('Failed to cancel:', e) }
  },

  cancelPdf: async (pdfId) => {
    set(state => {
      const pdfResults = { ...(state.resultsByPdf[pdfId] ?? {}) }
      const newProgress = { ...state.sourceProgress }
      let changed = false
      for (const sourceId of Object.keys(pdfResults)) {
        if (pdfResults[sourceId].status === 'in_progress') {
          pdfResults[sourceId] = { ...pdfResults[sourceId], status: 'not_found' as VerifyStatus }
          newProgress[sourceId] = { currentDb: null, checkedDbs: newProgress[sourceId]?.checkedDbs ?? [] }
          changed = true
        }
      }
      if (!changed) return state
      let found = 0, problematic = 0, not_found = 0
      for (const r of Object.values(pdfResults)) {
        if (r.status === 'found') found++
        else if (r.status === 'problematic') problematic++
        else if (r.status === 'not_found') not_found++
      }
      const newResults = { ...state.resultsByPdf, [pdfId]: pdfResults }
      const newSummaries = { ...state.summaries, [pdfId]: { pdf_id: pdfId, found, problematic, not_found, in_progress: 0, total: Object.keys(pdfResults).length, completed: true } }
      // Stop polling if no more in-progress across all PDFs
      const anyStillRunning = Object.entries(newResults).some(([id, res]) =>
        id !== pdfId && Object.values(res).some(r => r.status === 'in_progress')
      )
      if (!anyStillRunning) stopPolling()
      return { resultsByPdf: newResults, summaries: newSummaries, sourceProgress: newProgress }
    })
    try { await api.cancelPdfVerification(pdfId) } catch (e) { console.error('Failed to cancel PDF:', e) }
  },

  cancelSource: async (sourceId) => {
    set(state => {
      const newResults = { ...state.resultsByPdf }
      const newSummaries = { ...state.summaries }
      const newProgress = { ...state.sourceProgress }
      let targetPdfId: string | null = null
      for (const pdfId of Object.keys(newResults)) {
        const pdfResults = newResults[pdfId]
        if (pdfResults[sourceId]?.status === 'in_progress') {
          newResults[pdfId] = { ...pdfResults, [sourceId]: { ...pdfResults[sourceId], status: 'not_found' as VerifyStatus } }
          newProgress[sourceId] = { currentDb: null, checkedDbs: newProgress[sourceId]?.checkedDbs ?? [] }
          targetPdfId = pdfId
          break
        }
      }
      if (!targetPdfId) return state
      let found = 0, problematic = 0, not_found = 0
      for (const r of Object.values(newResults[targetPdfId])) {
        if (r.status === 'found') found++
        else if (r.status === 'problematic') problematic++
        else if (r.status === 'not_found') not_found++
      }
      newSummaries[targetPdfId] = { pdf_id: targetPdfId, found, problematic, not_found, in_progress: Object.values(newResults[targetPdfId]).filter(r => r.status === 'in_progress').length, total: Object.keys(newResults[targetPdfId]).length, completed: Object.values(newResults[targetPdfId]).every(r => r.status !== 'in_progress') }
      return { resultsByPdf: newResults, summaries: newSummaries, sourceProgress: newProgress }
    })
    try { await api.cancelSourceVerification(sourceId) } catch (e) { console.error('Failed to cancel source:', e) }
  },

  loadResults: async (pdfId) => {
    try {
      const response = await api.verifyResults(pdfId)
      const results = response.results
      const count = Object.keys(results).length
      if (count > 0) {
        console.log('%c[Loaded Verify Cache] %s (%d sources)', 'color: #60a5fa; font-weight: bold', pdfId, count)
        // Compute summary from cached results
        let found = 0, problematic = 0, not_found = 0, inProgress = 0
        for (const r of Object.values(results)) {
          if (r.status === 'found') found++
          else if (r.status === 'problematic') problematic++
          else if (r.status === 'not_found') not_found++
          else if (r.status === 'in_progress') inProgress++
        }
        set(state => ({
          resultsByPdf: { ...state.resultsByPdf, [pdfId]: results },
          summaries: {
            ...state.summaries,
            [pdfId]: {
              pdf_id: pdfId,
              found, problematic, not_found,
              in_progress: inProgress,
              total: count,
              completed: inProgress === 0,
            },
          },
        }))
      } else {
        set(state => ({
          resultsByPdf: { ...state.resultsByPdf, [pdfId]: results },
        }))
      }
    } catch (e) {
      console.error('Failed to load results:', e)
    }
  },
}))

export function initVerificationListeners(): () => void {
  const unsubs = [
    wsClient.on('verify_started', (data) => {
      const sourceId = data.source_id as string
      const pdfId = data.pdf_id as string

      // Buffer logging
      if (verifyBatch) {
        if (!verifyBatch.groupOpened) {
          console.groupCollapsed(`%c[Verify] ${verifyBatch.totalSources}`, 'color: #60a5fa; font-weight: bold')
          verifyBatch.groupOpened = true
        }
        if (!verifyBatch.pdfs.has(pdfId)) {
          verifyBatch.pdfs.set(pdfId, { pdfId, sources: new Map() })
        }
        verifyBatch.pdfs.get(pdfId)!.sources.set(sourceId, {
          sourceId,
          sourceText: (data.source_text as string) ?? '',
          dbChecks: [],
          finalStatus: null,
        })
      }

      useVerificationStore.setState(state => ({
        resultsByPdf: {
          ...state.resultsByPdf,
          [pdfId]: {
            ...(state.resultsByPdf[pdfId] ?? {}),
            [sourceId]: {
              source_id: sourceId,
              status: 'in_progress' as VerifyStatus,
              problem_tags: [],
              url_liveness: {},
              all_results: [],
              databases_searched: [],
            },
          },
        },
        sourceProgress: {
          ...state.sourceProgress,
          [sourceId]: { currentDb: null, checkedDbs: [] },
        },
      }))
    }),

    wsClient.on('verify_db_checking', (data) => {
      const sourceId = data.source_id as string
      const db = data.database as string

      useVerificationStore.setState(state => ({
        sourceProgress: {
          ...state.sourceProgress,
          [sourceId]: {
            ...(state.sourceProgress[sourceId] ?? { currentDb: null, checkedDbs: [] }),
            currentDb: db,
          },
        },
      }))
    }),

    wsClient.on('verify_db_checked', (data) => {
      const pdfId = data.pdf_id as string
      const sourceId = data.source_id as string
      const dbName = data.database as string
      const dbStatus = (data.db_status as DbCheckStatus) || (data.found ? 'found' : 'not_found')
      const found = data.found as boolean

      // Buffer logging
      if (verifyBatch) {
        const pdfLog = verifyBatch.pdfs.get(pdfId)
        const sourceLog = pdfLog?.sources.get(sourceId)
        if (sourceLog) {
          sourceLog.dbChecks.push({
            database: dbName,
            dbStatus,
            match: (data.match as Record<string, unknown>) ?? null,
            searchUrl: (data.search_url as string | undefined)
              ?? ((data.match as Record<string, unknown> | undefined)?.search_url as string | undefined)
              ?? '',
          })
        }
      }

      useVerificationStore.setState(state => {
        const prev = state.resultsByPdf[pdfId]?.[sourceId]
        const prog = state.sourceProgress[sourceId]
        const newEntry: DbCheckEntry = {
          name: dbName,
          status: dbStatus,
          searchUrl: (data.search_url as string)
            ?? ((data.match as Record<string, unknown> | undefined)?.search_url as string | undefined)
            ?? '',
        }

        return {
          resultsByPdf: prev
            ? {
                ...state.resultsByPdf,
                [pdfId]: {
                  ...state.resultsByPdf[pdfId],
                  [sourceId]: {
                    ...prev,
                    databases_searched: [...prev.databases_searched, dbName],
                    all_results: data.match ? [...prev.all_results, data.match as any] : prev.all_results,
                  },
                },
              }
            : state.resultsByPdf,
          sourceProgress: {
            ...state.sourceProgress,
            [sourceId]: {
              currentDb: null,
              checkedDbs: [...(prog?.checkedDbs ?? []), newEntry],
            },
          },
        }
      })
    }),

    wsClient.on('verify_source_done', (data) => {
      const pdfId = data.pdf_id as string
      const sourceId = data.source_id as string
      const status = data.status as string

      // Buffer logging
      if (verifyBatch) {
        const pdfLog = verifyBatch.pdfs.get(pdfId)
        const sourceLog = pdfLog?.sources.get(sourceId)
        if (sourceLog) {
          sourceLog.finalStatus = status
        }
      }

      useVerificationStore.setState(state => {
        const existing = state.resultsByPdf[pdfId] ?? {}
        return {
          resultsByPdf: {
            ...state.resultsByPdf,
            [pdfId]: {
              ...existing,
              [sourceId]: {
                source_id: sourceId,
                status: data.status as VerifyStatus,
                problem_tags: (data.problem_tags as string[]) ?? [],
                url_liveness: (data.url_liveness as Record<string, boolean>) ?? {},
                best_match: data.best_match as any,
                all_results: (data.all_results as any[]) ?? [],
                databases_searched: existing[sourceId]?.databases_searched ?? [],
              },
            },
          },
          sourceProgress: {
            ...state.sourceProgress,
            [sourceId]: {
              currentDb: null,
              checkedDbs: state.sourceProgress[sourceId]?.checkedDbs ?? [],
            },
          },
        }
      })
    }),

    wsClient.on('verify_pdf_done', (data) => {
      const pdfId = data.pdf_id as string
      const found = (data.found as number | undefined) ?? 0
      const problematic = (data.problematic as number | undefined) ?? 0
      const not_found = (data.not_found as number | undefined) ?? 0
      useVerificationStore.setState(state => ({
        summaries: {
          ...state.summaries,
          [pdfId]: {
            pdf_id: pdfId,
            found,
            problematic,
            not_found,
            in_progress: 0,
            total: found + problematic + not_found,
            completed: true,
          },
        },
      }))

      // Stop polling if all polled PDFs are now complete
      if (pollingPdfIds.length > 0) {
        const sums = useVerificationStore.getState().summaries
        if (pollingPdfIds.every(id => sums[id]?.completed)) stopPolling()
      }

      // Flush buffered log for this PDF
      if (verifyBatch) {
        flushPdfVerifyLog(pdfId)
        verifyBatch.completedPdfs++
        if (verifyBatch.completedPdfs >= verifyBatch.expectedPdfCount) {
          if (verifyBatch.groupOpened) console.groupEnd() // close [Verify] group
          verifyBatch = null
        }
      }
    }),

    wsClient.on('verify_pdf_updated', (data) => {
      const pdfId = data.pdf_id as string
      useVerificationStore.setState(state => {
        if (!state.summaries[pdfId]) return state
        const found = (data.found as number | undefined) ?? state.summaries[pdfId].found
        const problematic = (data.problematic as number | undefined) ?? state.summaries[pdfId].problematic
        const not_found = (data.not_found as number | undefined) ?? state.summaries[pdfId].not_found
        return {
          summaries: {
            ...state.summaries,
            [pdfId]: {
              ...state.summaries[pdfId],
              found,
              problematic,
              not_found,
              total: found + problematic + not_found,
            },
          },
        }
      })

      // For verify (single source), also flush
      if (verifyBatch) {
        flushPdfVerifyLog(pdfId)
        verifyBatch.completedPdfs++
        if (verifyBatch.completedPdfs >= verifyBatch.expectedPdfCount) {
          if (verifyBatch.groupOpened) console.groupEnd()
          verifyBatch = null
        }
      }
    }),
  ]

  return () => {
    unsubs.forEach(fn => fn())
    stopPolling()
  }
}

export function clearVerificationForPdf(pdfId: string): void {
  pollingPdfIds = pollingPdfIds.filter(id => id !== pdfId)
  if (pollingPdfIds.length === 0) {
    stopPolling()
  }

  useVerificationStore.setState(state => {
    const sourceIds = state.sourceOrder[pdfId] ?? []

    const resultsByPdf = { ...state.resultsByPdf }
    const summaries = { ...state.summaries }
    const sourceOrder = { ...state.sourceOrder }
    const sourceProgress = { ...state.sourceProgress }
    const verifyTexts = { ...state.verifyTexts }
    const sourceOriginalTexts = { ...state.sourceOriginalTexts }
    const enabledSources = { ...state.enabledSources }

    delete resultsByPdf[pdfId]
    delete summaries[pdfId]
    delete sourceOrder[pdfId]

    for (const sourceId of sourceIds) {
      delete sourceProgress[sourceId]
      delete verifyTexts[sourceId]
      delete sourceOriginalTexts[sourceId]
      delete enabledSources[sourceId]
    }

    const shouldClearSelection =
      state.selectedSourceId !== null && sourceIds.includes(state.selectedSourceId)

    return {
      resultsByPdf,
      summaries,
      sourceOrder,
      sourceProgress,
      verifyTexts,
      sourceOriginalTexts,
      enabledSources,
      selectedSourceId: shouldClearSelection ? null : state.selectedSourceId,
    }
  })
}
