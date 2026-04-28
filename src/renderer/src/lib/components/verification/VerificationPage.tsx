import { useState, useMemo, useEffect, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import i18n from '../../i18n'
import { usePdfStore } from '../../stores/pdf-store'
import { useSourcesStore, loadSources as loadSourcesFn } from '../../stores/sources-store'
import { useVerificationStore } from '../../stores/verification-store'
import { useSettingsStore } from '../../stores/settings-store'
import { useScholarScanStore } from '../../stores/scholar-scan-store'
import { scholarScanner, PROBE_PAGE_STATE_SCRIPT, buildSearchUrl } from '../../services/scholar-scanner'
import type { VerificationResult, MatchResult, DbCheckEntry, TagKey } from '../../api/types'
import { api } from '../../api/rest-client'
import { TAG_ORDER, effectiveTagOn, effectiveTrustTag } from '../../verification/tagState'
import { sanitizeReferenceText, sanitizeReferenceTextForSearch } from '../../utils/reference-text'
import { buildDefaultSavePath } from '../../utils/path'
import {
  dbScoreColor,
  dbScoreIcon,
  verifyStatusColor as statusColor,
} from '../../utils/status-helpers'
import { STATUS_HEX, TRUST_HEX } from '../../constants/colors'
import {
  BROWSER_ZOOM_STEP,
  MAX_BROWSER_ZOOM,
  MIN_BROWSER_ZOOM,
  VERIFY_TOAST_DURATION_MS,
} from '../../constants/timings'
import styles from './VerificationPage.module.css'

function problemTagDescription(tag: string): string {
  switch (tag) {
    case '!authors': return i18n.t('verification.problemDesc.authors')
    case '!doi/arXiv': return i18n.t('verification.problemDesc.doi')
    case '!year': return i18n.t('verification.problemDesc.year')
    case '!source': return i18n.t('verification.problemDesc.source')
    case '!title': return i18n.t('verification.problemDesc.title')
    default: return tag
  }
}

function problemTagLabel(tag: string): string {
  const key = `verification.problemTag.${tag}`
  const translated = i18n.t(key)
  return translated === key ? tag : translated
}


function googleSearchUrl(text: string): string {
  const cleaned = sanitizeReferenceTextForSearch(text)
  return `https://www.google.com/search?q=${encodeURIComponent(cleaned)}`
}

function buildDbSearchUrl(db: string, text: string): string {
  const cleaned = sanitizeReferenceTextForSearch(text)
  if (!cleaned) return ''
  const q = encodeURIComponent(cleaned)
  const qPlus = q.replace(/%20/g, '+')
  const urls: Record<string, string> = {
    'Crossref': `https://search.crossref.org/search/works?q=${qPlus}&from_ui=yes`,
    'OpenAlex': `https://openalex.org/works?search=${q}`,
    'arXiv': `https://arxiv.org/search/?query=${q}&searchtype=all`,
    'Semantic Scholar': `https://www.semanticscholar.org/search?q=${q}`,
    'Europe PMC': `https://europepmc.org/search?query=${q}`,
    'TRDizin': `https://search.trdizin.gov.tr/tr/yayin/ara?q=${q.replace(/%2C/gi, ',')}&order=relevance-DESC&page=1&limit=5`,
    'PubMed': `https://pubmed.ncbi.nlm.nih.gov/?term=${q}`,
    'OpenAIRE': `https://explore.openaire.eu/search/find?fv0=${q}&f0=q`,
    'Open Library': `https://openlibrary.org/search?q=${q}`,
    'Google Scholar': `https://scholar.google.com/scholar?q=${q}`,
  }
  return urls[db] ?? ''
}

const statusOrder: Record<string, number> = { found: 0, problematic: 1, not_found: 2, in_progress: 3, pending: 4 }
type CardSortMode = 'status' | 'ref' | 'enabled' | 'trust'

export default function VerificationPage() {
  const { t } = useTranslation()
  const verifyCenterRef = useRef<HTMLElement | null>(null)
  const cardListRef = useRef<HTMLDivElement | null>(null)
  const allPdfs = usePdfStore(s => s.pdfs)
  const selectedPdfId = usePdfStore(s => s.selectedPdfId)
  const selectPdf = usePdfStore(s => s.selectPdf)

  const sourcesByPdf = useSourcesStore(s => s.sourcesByPdf)

  const resultsByPdf = useVerificationStore(s => s.resultsByPdf)
  const summaries = useVerificationStore(s => s.summaries)
  const sourceProgress = useVerificationStore(s => s.sourceProgress)
  const selectedSourceId = useVerificationStore(s => s.selectedSourceId)
  const verifyTexts = useVerificationStore(s => s.verifyTexts)
  const sourceOriginalTexts = useVerificationStore(s => s.sourceOriginalTexts)
  const enabledSources = useVerificationStore(s => s.enabledSources)
  const sourceOrder = useVerificationStore(s => s.sourceOrder)
  const cardSortKey = useVerificationStore(s => s.cardSortKey)
  const cardSortAsc = useVerificationStore(s => s.cardSortAsc)
  const pdfSortKey = useVerificationStore(s => s.pdfSortKey)
  const pdfSortAsc = useVerificationStore(s => s.pdfSortAsc)
  const verifyCutoffIndex = useVerificationStore(s => s.verifyCutoffIndex)
  const setVerifyCutoffIndex = useVerificationStore(s => s.setVerifyCutoffIndex)

  const configuredDatabases = useSettingsStore(s => s.settings.databases)
  const enabledDatabases = useMemo(() => {
    const known = new Set([
      'Crossref', 'OpenAlex', 'OpenAIRE', 'Europe PMC', 'arXiv',
      'PubMed', 'TRDizin', 'Open Library', 'Semantic Scholar',
    ])
    return configuredDatabases
      .filter(db => db.enabled && known.has(db.name))
      .map(db => db.name)
  }, [configuredDatabases])

  const pdfs = useMemo(() => allPdfs.filter(p => p.status === 'approved'), [allPdfs])
  const effectivePdfId = useMemo(
    () => (selectedPdfId && pdfs.some(p => p.id === selectedPdfId) ? selectedPdfId : null),
    [selectedPdfId, pdfs],
  )
  const results = useMemo(() => (effectivePdfId ? (resultsByPdf[effectivePdfId] ?? {}) : {}), [resultsByPdf, effectivePdfId])
  const sources = useMemo(() => (effectivePdfId ? (sourcesByPdf[effectivePdfId] ?? []) : []), [sourcesByPdf, effectivePdfId])
  const currentResult = useMemo(() => (selectedSourceId ? results[selectedSourceId] : undefined), [results, selectedSourceId])
  const currentSource = useMemo(() => (selectedSourceId ? sources.find(s => s.id === selectedSourceId) : undefined), [sources, selectedSourceId])
  const cardRefs = useRef<Record<string, HTMLDivElement | null>>({})
  // When a status-changing action reorders the sorted list, this ref names the
  // card to keep visible so the user doesn't lose their place.
  const pendingScrollCardIdRef = useRef<string | null>(null)
  // Cross-PDF right-click jump: remembers the target source to select+scroll
  // after selectPdf swaps the card list.
  const pendingJumpRef = useRef<{ pdfId: string; sourceId: string } | null>(null)
  // Snapshot of the left-panel count pills captured whenever a PDF finishes a
  // complete verification run. While a re-verify is in flight on a PDF that
  // already has a complete snapshot, we render this snapshot instead of the
  // live (in-progress, decrementing) counts so the user's reference point
  // doesn't jitter until the new run finishes or is stopped.
  const frozenPdfCountsRef = useRef<Record<string, {
    found: number
    problematic: number
    not_found: number
    trustValid: number
    trustKunye: number
    trustUydurma: number
  }>>({})
  const currentSummary = useMemo(() => (effectivePdfId ? summaries[effectivePdfId] : undefined), [summaries, effectivePdfId])
  const orderedSourceIds = useMemo(() => (effectivePdfId ? (sourceOrder[effectivePdfId] ?? []) : []), [sourceOrder, effectivePdfId])

  // Sort-dropdown open state + click-outside wiring
  const [sortOpen, setSortOpen] = useState(false)
  const sortDropdownRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!sortOpen) return
    const onDocClick = (e: MouseEvent) => {
      if (sortDropdownRef.current && !sortDropdownRef.current.contains(e.target as Node)) {
        setSortOpen(false)
      }
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [sortOpen])

  // Verify-All split-button dropdown + click-outside wiring
  const [verifyAllMenuOpen, setVerifyAllMenuOpen] = useState(false)
  const verifyAllMenuRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!verifyAllMenuOpen) return
    const onDocClick = (e: MouseEvent) => {
      if (verifyAllMenuRef.current && !verifyAllMenuRef.current.contains(e.target as Node)) {
        setVerifyAllMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [verifyAllMenuOpen])

  // Toast for verification completion – only for actual runs, not cached loads
  const [verifyToast, setVerifyToast] = useState<string | null>(null)
  const verifyToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // PDFs whose verification run we kicked off in this session and are still
  // waiting to see complete. Adding a pdfId here arms the completion handler.
  const pendingVerifyPdfIdsRef = useRef<Set<string>>(new Set())
  // PDFs started via single-PDF verify (not Verify All) — auto-run GS when done
  const autoGsPdfIdsRef = useRef<Set<string>>(new Set())
  // PDFs for which GS scan must run unconditionally after verification (ignoring setting).
  // Used by the "~X" (verify non-found) button.
  const forceGsPdfIdsRef = useRef<Set<string>>(new Set())
  // Single-source reverify runs awaiting completion to trigger a per-source GS scan.
  // Maps sourceId -> pdfId.
  const pendingSingleSourceGsRef = useRef<Map<string, string>>(new Map())
  // Deferred toast: when Scholar scan will run after verification, hold the
  // toast until the scan finishes so the user sees one final notification.
  const deferredToastNameRef = useRef<string | null>(null)
  // Sequential "Verify All" queue state
  const verifyAllQueueRef = useRef<string[]>([])
  const verifyAllCurrentRef = useRef<string | null>(null)
  const verifyAllActiveRef = useRef(false)
  const verifyAllModeRef = useRef<'all' | 'nonFound'>('all')
  const [verifyAllActive, setVerifyAllActive] = useState(false)
  const [lastVerifyAllMode, setLastVerifyAllMode] = useState<'all' | 'nonFound'>('all')
  const [exportingReport, setExportingReport] = useState(false)

  // Fire completion-time side effects (toast + auto Scholar scan) when a
  // pending verification run transitions to completed. We trigger off
  // `summary.completed` directly rather than an in_progress→0 edge because
  // `verify_source_done` and `verify_pdf_done` arrive in separate ticks,
  // and the edge is not observable in a single summaries snapshot.
  useEffect(() => {
    for (const pdfId of Array.from(pendingVerifyPdfIdsRef.current)) {
      const summary = summaries[pdfId]
      if (!summary || !summary.completed || summary.in_progress > 0) continue
      pendingVerifyPdfIdsRef.current.delete(pdfId)

      // Under status sort, slide the cutoff bar up by one as each PDF
      // finishes — the PDF has just moved from the in-progress tier at the
      // top of the list to the completed tier at the bottom, so a matching
      // bar shift keeps the "remaining queue" framing intact.
      {
        const store = useVerificationStore.getState()
        if (store.pdfSortKey === 'status') {
          const current = Math.min(store.verifyCutoffIndex, pdfs.length)
          store.setVerifyCutoffIndex(Math.max(0, current - 1))
        }
      }

      const pdf = allPdfs.find(p => p.id === pdfId)
      const name = pdf?.name ?? 'PDF'

      let willRunScholar = false

      if (autoGsPdfIdsRef.current.has(pdfId)) {
        autoGsPdfIdsRef.current.delete(pdfId)
        const autoGs = useSettingsStore.getState().settings.auto_scholar_after_verify ?? true
        if (autoGs) {
          willRunScholar = true
          setTimeout(() => {
            useScholarScanStore.getState().startScanForPdf(pdfId)
          }, 500)
        }
      }

      if (forceGsPdfIdsRef.current.has(pdfId)) {
        forceGsPdfIdsRef.current.delete(pdfId)
        const autoGs = useSettingsStore.getState().settings.auto_scholar_after_verify ?? true
        if (autoGs) {
          willRunScholar = true
          setTimeout(() => {
            useScholarScanStore.getState().startScanForPdf(pdfId)
          }, 500)
        }
      }

      if (willRunScholar) {
        // Defer the toast until Scholar scan finishes
        deferredToastNameRef.current = name
      } else {
        if (verifyToastTimerRef.current) clearTimeout(verifyToastTimerRef.current)
        setVerifyToast(t('verification.verificationComplete', { name }))
        verifyToastTimerRef.current = setTimeout(() => setVerifyToast(null), VERIFY_TOAST_DURATION_MS)
      }

      // Advance the sequential "Verify All" queue if this PDF was the active one.
      if (verifyAllActiveRef.current && verifyAllCurrentRef.current === pdfId) {
        verifyAllCurrentRef.current = null
        void processNextInQueueRef.current?.()
      }
    }
  }, [summaries, allPdfs])

  // Sequential queue runner. Stored in a ref so the completion useEffect can
  // call it without becoming a dependency cycle.
  const processNextInQueueRef = useRef<(() => Promise<void>) | null>(null)
  const processNextInQueue = useCallback(async () => {
    while (verifyAllActiveRef.current) {
      const next = verifyAllQueueRef.current.shift()
      if (!next) {
        verifyAllActiveRef.current = false
        verifyAllCurrentRef.current = null
        setVerifyAllActive(false)
        return
      }
      await loadSourcesFn(next)
      const src = useSourcesStore.getState().sourcesByPdf[next] ?? []
      if (src.length === 0) continue

      if (verifyAllModeRef.current === 'nonFound') {
        const store = useVerificationStore.getState()
        // Ensure cached results are in memory before filtering — a PDF the user
        // hasn't opened this session may have empty resultsByPdf, racing the
        // passive auto-load effect.
        await store.loadResults(next)
        const { resultsByPdf, enabledSources } = useVerificationStore.getState()
        const pdfResults = resultsByPdf[next] ?? {}
        const hasNonFound = src.some(s => {
          if (enabledSources[s.id] === false) return false
          return pdfResults[s.id]?.status !== 'found'
        })
        if (!hasNonFound) continue

        store.initSourceVerifyState(next, src)
        verifyAllCurrentRef.current = next
        selectPdf(next)
        pendingVerifyPdfIdsRef.current.add(next)
        forceGsPdfIdsRef.current.add(next)
        await useVerificationStore.getState().startVerificationNonFoundForPdf(next)
        return
      }

      verifyAllCurrentRef.current = next
      selectPdf(next)
      pendingVerifyPdfIdsRef.current.add(next)
      autoGsPdfIdsRef.current.add(next)
      await useVerificationStore.getState().startVerification([next])
      return
    }
  }, [selectPdf])
  processNextInQueueRef.current = processNextInQueue

  const orderedSources = useMemo(() => {
    const sourceMap = new Map(sources.map(s => [s.id, s]))
    return orderedSourceIds.map(id => sourceMap.get(id)).filter(Boolean) as typeof sources
  }, [sources, orderedSourceIds])

  const enabledCount = useMemo(
    () => orderedSources.filter(s => enabledSources[s.id] ?? true).length,
    [orderedSources, enabledSources],
  )
  const areAllSourcesEnabled = useMemo(
    () => orderedSources.length > 0 && enabledCount === orderedSources.length,
    [orderedSources.length, enabledCount],
  )

  const sourceCards = useMemo(
    () => orderedSources.map(source => ({
      source,
      result: results[source.id] as VerificationResult | undefined,
      progress: sourceProgress[source.id],
      enabled: enabledSources[source.id] ?? true,
    })),
    [orderedSources, results, sourceProgress, enabledSources],
  )

  // --- Left panel sorting (persisted in store) ---
  const { togglePdfSort } = useVerificationStore.getState()

  // Per-PDF trust counts, computed from the in-memory results map.
  // Kept in sync with the left-panel count pills and the new trust sorts.
  const trustCountsByPdf = useMemo(() => {
    const out: Record<string, { valid: number; kunye: number; uydurma: number }> = {}
    for (const pdfId of Object.keys(resultsByPdf)) {
      let v = 0, k = 0, u = 0
      for (const r of Object.values(resultsByPdf[pdfId] ?? {})) {
        // Skip sources still mid-verification — they'd otherwise get
        // classified as Uydurma before the best match lands.
        if (r.status === 'in_progress' || r.status === 'pending') continue
        // Cancelling a Verify All run flips every in-flight source to
        // not_found optimistically. Sources the backend never got to touch
        // arrive with an empty databases_searched and no best_match, which
        // would otherwise inflate the Uydurma pill to the full ref count
        // until the PDF is reopened and loadResults re-syncs.
        if (
          r.status === 'not_found'
          && !r.best_match
          && (r.databases_searched?.length ?? 0) === 0
        ) continue
        const tt = effectiveTrustTag(r)
        if (tt === 'clean') v++
        else if (tt === 'künye') k++
        else if (tt === 'uydurma') u++
      }
      out[pdfId] = { valid: v, kunye: k, uydurma: u }
    }
    return out
  }, [resultsByPdf])

  const sortedPdfs = useMemo(() => {
    const list = [...pdfs]
    const dir = pdfSortAsc ? 1 : -1
    // Mirror of the render-time freeze: if a PDF is currently re-verifying
    // and we have a snapshot from its last complete run, sort by that
    // snapshot so the row doesn't drop to the bottom and climb back up as
    // the live counts decrement and recover.
    const getSortValues = (pdfId: string) => {
      const pdfResults = resultsByPdf[pdfId]
      const verifying = pdfResults ? Object.values(pdfResults).some(r => r.status === 'in_progress') : false
      const frozen = verifying ? frozenPdfCountsRef.current[pdfId] : undefined
      const s = summaries[pdfId]
      const t = trustCountsByPdf[pdfId] ?? { valid: 0, kunye: 0, uydurma: 0 }
      return {
        found: frozen ? frozen.found : (s?.found ?? 0),
        problematic: frozen ? frozen.problematic : (s?.problematic ?? 0),
        not_found: frozen ? frozen.not_found : (s?.not_found ?? 0),
        valid: frozen ? frozen.trustValid : t.valid,
        kunye: frozen ? frozen.trustKunye : t.kunye,
        uydurma: frozen ? frozen.trustUydurma : t.uydurma,
      }
    }
    list.sort((a, b) => {
      const sa = summaries[a.id]
      const sb = summaries[b.id]
      if (pdfSortKey === 'name') return dir * a.name.localeCompare(b.name)
      if (pdfSortKey === 'status') {
        // Tiers ordered so the default first-click direction (desc) puts
        // the list top→bottom as: in-progress → untouched → partial → completed.
        // When there are no in-progress PDFs (the typical state when the user
        // first clicks the sort button) untouched lands at the top.
        const tier = (pdfId: string, s: typeof sa) => {
          const pdfRes = resultsByPdf[pdfId]
          const running = pdfRes
            ? Object.values(pdfRes).some(r => r.status === 'in_progress')
            : (s?.in_progress ?? 0) > 0
          if (running) return 3
          if (!s) return 2
          if (!s.completed) return 1
          return 0
        }
        return dir * (tier(a.id, sa) - tier(b.id, sb))
      }
      const va = getSortValues(a.id)
      const vb = getSortValues(b.id)
      if (pdfSortKey === 'found') return dir * (va.found - vb.found)
      if (pdfSortKey === 'problematic') return dir * (va.problematic - vb.problematic)
      if (pdfSortKey === 'not_found') return dir * (va.not_found - vb.not_found)
      if (pdfSortKey === 'valid') return dir * (va.valid - vb.valid)
      if (pdfSortKey === 'kunye') return dir * (va.kunye - vb.kunye)
      if (pdfSortKey === 'uydurma') return dir * (va.uydurma - vb.uydurma)
      return 0
    })
    return list
  }, [pdfs, pdfSortKey, pdfSortAsc, summaries, trustCountsByPdf, resultsByPdf])

  // --- Center panel sorting (persisted in store) ---
  const { toggleCardSort } = useVerificationStore.getState()

  const sortedSourceCards = useMemo(() => {
    const list = [...sourceCards]
    const dir = cardSortAsc ? 1 : -1
    list.sort((a, b) => {
      if (cardSortKey === 'status') {
        const ao = statusOrder[a.result?.status ?? 'pending'] ?? 4
        const bo = statusOrder[b.result?.status ?? 'pending'] ?? 4
        return dir * (ao - bo)
      }
      if (cardSortKey === 'ref') {
        return dir * ((a.source.ref_number ?? 999) - (b.source.ref_number ?? 999))
      }
      if (cardSortKey === 'trust') {
        // Order values chosen so that ascending (dir=+1) puts Uydurma first —
        // but default direction is desc (asc=false, dir=-1), which flips to
        // Geçerli-first. Invert by using the complement so the DEFAULT click
        // lands on Uydurma → Künye → Geçerli.
        const trustOrder: Record<string, number> = { uydurma: 0, 'künye': 1, clean: 2 }
        const ao = trustOrder[effectiveTrustTag(a.result)] ?? 99
        const bo = trustOrder[effectiveTrustTag(b.result)] ?? 99
        return -dir * (ao - bo)
      }
      // enabled: enabled first when ascending
      const ae = a.enabled ? 0 : 1
      const be = b.enabled ? 0 : 1
      return dir * (ae - be)
    })
    return list
  }, [sourceCards, cardSortKey, cardSortAsc])

  // Always reload sources when a PDF is selected or when the user navigates
  // back to the verification page (sources may have changed on parsing page).
  useEffect(() => {
    if (effectivePdfId) {
      const { loadResults, initSourceVerifyState } = useVerificationStore.getState()
      ;(async () => {
        await loadSourcesFn(effectivePdfId)
        const s = useSourcesStore.getState().sourcesByPdf[effectivePdfId] ?? []
        initSourceVerifyState(effectivePdfId, s)
        await loadResults(effectivePdfId)
      })()
    }
  }, [effectivePdfId])

  // Auto-load cached results for all approved PDFs — including any newly
  // imported after initial mount, so left-panel count pills appear without
  // the user having to click each PDF first.
  const autoLoadedPdfIdsRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (pdfs.length === 0) return
    const pending = pdfs.filter(p => !autoLoadedPdfIdsRef.current.has(p.id))
    if (pending.length === 0) return
    for (const p of pending) autoLoadedPdfIdsRef.current.add(p.id)
    const { loadResults } = useVerificationStore.getState()
    ;(async () => {
      for (const pdf of pending) {
        await loadResults(pdf.id)
      }
    })()
  }, [pdfs])

  const [cardSearchQuery, setCardSearchQuery] = useState('')

  const filteredSourceCards = useMemo(() => {
    const q = cardSearchQuery.trim().toLowerCase()
    if (!q) return sortedSourceCards
    const matched = sortedSourceCards.filter(card => {
      const text = (verifyTexts[card.source.id] ?? card.source.text ?? '').toLowerCase()
      const ref = String(card.source.ref_number ?? '')
      return text.includes(q) || ref.includes(q)
    })
    const rank = (card: typeof matched[number]) => {
      const ref = String(card.source.ref_number ?? '')
      if (ref === q) return 0
      if (ref.startsWith(q)) return 1
      if (ref.includes(q)) return 2
      return 3
    }
    return [...matched].sort((a, b) => rank(a) - rank(b))
  }, [sortedSourceCards, cardSearchQuery, verifyTexts])

  // Drag and drop state
  const [dragSourceId, setDragSourceId] = useState<string | null>(null)
  const [dropTargetIdx, setDropTargetIdx] = useState<number | null>(null)

  function onDragStart(e: React.DragEvent, sourceId: string) {
    setDragSourceId(sourceId)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', sourceId)
  }

  function onDragOver(e: React.DragEvent, idx: number) {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDropTargetIdx(idx)
  }

  function onDrop(e: React.DragEvent, toIdx: number) {
    e.preventDefault()
    if (!effectivePdfId || !dragSourceId) return
    const fromIdx = orderedSourceIds.indexOf(dragSourceId)
    if (fromIdx >= 0 && fromIdx !== toIdx) {
      useVerificationStore.getState().reorderSources(effectivePdfId, fromIdx, toIdx)
    }
    setDragSourceId(null)
    setDropTargetIdx(null)
  }

  function onDragEnd() {
    setDragSourceId(null)
    setDropTargetIdx(null)
  }

  // Verify-All cutoff divider: refs to each PDF item so we can compute which
  // slot the cursor is over during a drag.
  const pdfItemRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  const setPdfItemRef = useCallback((id: string) => (el: HTMLDivElement | null) => {
    if (el) pdfItemRefs.current.set(id, el)
    else pdfItemRefs.current.delete(id)
  }, [])
  const [cutoffDragging, setCutoffDragging] = useState(false)

  function startCutoffDrag(e: React.MouseEvent<HTMLDivElement>) {
    e.preventDefault()
    setCutoffDragging(true)
  }

  // Auto-resize textarea
  const autoResize = useCallback((el: HTMLTextAreaElement) => {
    el.style.height = 'auto'
    el.style.height = el.scrollHeight + 'px'
  }, [])

  // Compute running state for toggle buttons
  const isAnyVerifying = useMemo(() => {
    for (const pdfResults of Object.values(resultsByPdf)) {
      for (const r of Object.values(pdfResults)) {
        if (r.status === 'in_progress') return true
      }
    }
    return false
  }, [resultsByPdf])

  const isPdfVerifying = useCallback((pdfId: string) => {
    const pdfResults = resultsByPdf[pdfId]
    if (!pdfResults) return false
    return Object.values(pdfResults).some(r => r.status === 'in_progress')
  }, [resultsByPdf])

  // Refresh the frozen snapshot whenever a PDF is idle AND its counts cover
  // the full reference total — that's the moment the pills show a complete
  // run. The snapshot is then rendered in place of the live counts while a
  // re-verify is running (see the left-panel render below).
  useEffect(() => {
    for (const pdf of pdfs) {
      if (isPdfVerifying(pdf.id)) continue
      const summary = summaries[pdf.id]
      if (!summary || summary.total <= 0) continue
      if (summary.found + summary.problematic + summary.not_found < summary.total) continue
      const trust = trustCountsByPdf[pdf.id] ?? { valid: 0, kunye: 0, uydurma: 0 }
      frozenPdfCountsRef.current[pdf.id] = {
        found: summary.found,
        problematic: summary.problematic,
        not_found: summary.not_found,
        trustValid: trust.valid,
        trustKunye: trust.kunye,
        trustUydurma: trust.uydurma,
      }
    }
  }, [pdfs, summaries, trustCountsByPdf, isPdfVerifying])

  // Actions
  async function handleStartOrCancel(mode: 'all' | 'nonFound' = 'all') {
    if (verifyAllActiveRef.current || isAnyVerifying) {
      // Stop the queue and cancel the in-flight PDF (if any).
      verifyAllActiveRef.current = false
      verifyAllQueueRef.current = []
      setVerifyAllActive(false)
      const cur = verifyAllCurrentRef.current
      verifyAllCurrentRef.current = null
      if (cur) {
        autoGsPdfIdsRef.current.delete(cur)
        forceGsPdfIdsRef.current.delete(cur)
        pendingVerifyPdfIdsRef.current.delete(cur)
        await useVerificationStore.getState().cancelPdf(cur)
      } else {
        // Clear all tracking refs so the completion effect doesn't
        // trigger Scholar scans for cancelled verifications.
        autoGsPdfIdsRef.current.clear()
        forceGsPdfIdsRef.current.clear()
        pendingVerifyPdfIdsRef.current.clear()
        deferredToastNameRef.current = null
        await useVerificationStore.getState().cancelAll()
      }
    } else {
      const cutoff = Math.min(verifyCutoffIndex, sortedPdfs.length)
      const ids = sortedPdfs.slice(0, cutoff).map(p => p.id)
      if (ids.length > 0) {
        verifyAllModeRef.current = mode
        verifyAllQueueRef.current = [...ids]
        verifyAllActiveRef.current = true
        setVerifyAllActive(true)
        await processNextInQueue()
      }
    }
  }

  async function handleVerifyOrCancelPdf(pdfId: string) {
    if (isPdfVerifying(pdfId)) {
      // If the user stops the PDF that Verify All is currently working on,
      // tear down the whole queue so the main button flips back to Verify All
      // and the completion effect doesn't advance to the next PDF.
      if (verifyAllActiveRef.current && verifyAllCurrentRef.current === pdfId) {
        verifyAllActiveRef.current = false
        verifyAllQueueRef.current = []
        verifyAllCurrentRef.current = null
        setVerifyAllActive(false)
      }
      autoGsPdfIdsRef.current.delete(pdfId)
      pendingVerifyPdfIdsRef.current.delete(pdfId)
      await useVerificationStore.getState().cancelPdf(pdfId)
    } else {
      autoGsPdfIdsRef.current.add(pdfId)
      pendingVerifyPdfIdsRef.current.add(pdfId)
      await useVerificationStore.getState().startVerification([pdfId])
    }
  }

  async function handleVerifyNonFoundPdf(pdfId: string) {
    if (isPdfVerifying(pdfId)) return
    await loadSourcesFn(pdfId)
    const src = useSourcesStore.getState().sourcesByPdf[pdfId] ?? []
    useVerificationStore.getState().initSourceVerifyState(pdfId, src)
    pendingVerifyPdfIdsRef.current.add(pdfId)
    forceGsPdfIdsRef.current.add(pdfId)
    await useVerificationStore.getState().startVerificationNonFoundForPdf(pdfId)
  }

  async function handleReverifyOrCancelSource() {
    if (!effectivePdfId || !selectedSourceId) return
    if (currentResult?.status === 'in_progress') {
      pendingSingleSourceGsRef.current.delete(selectedSourceId)
      await useVerificationStore.getState().cancelSource(selectedSourceId)
    } else {
      const text = useVerificationStore.getState().verifyTexts[selectedSourceId]
      pendingSingleSourceGsRef.current.set(selectedSourceId, effectivePdfId)
      await useVerificationStore.getState().reverifySource(effectivePdfId, selectedSourceId, text)
    }
  }

  // When a single-source reverify finishes, trigger a per-source Scholar scan
  // if the final status is not 'found'.
  useEffect(() => {
    for (const [sourceId, pdfId] of Array.from(pendingSingleSourceGsRef.current)) {
      const r = resultsByPdf[pdfId]?.[sourceId]
      if (!r || r.status === 'in_progress') continue
      pendingSingleSourceGsRef.current.delete(sourceId)
      const autoGs = useSettingsStore.getState().settings.auto_scholar_after_verify ?? true
      if (autoGs) {
        setTimeout(() => {
          useScholarScanStore.getState().startScanForSource(pdfId, sourceId)
        }, 500)
      }
    }
  }, [resultsByPdf])

  async function handleOverride(status: 'found' | 'problematic' | 'not_found') {
    if (!effectivePdfId || !selectedSourceId || !currentResult) return
    pendingScrollCardIdRef.current = selectedSourceId
    await useVerificationStore.getState().overrideStatus(effectivePdfId, selectedSourceId, status)
  }

  async function handleExportVerificationReport() {
    if (!effectivePdfId) return
    const pdfResults = resultsByPdf[effectivePdfId]
    if (!pdfResults || Object.keys(pdfResults).length === 0) {
      window.alert(t('verification.exportPdfNoResults'))
      return
    }
    setExportingReport(true)
    try {
      const pdfName = pdfs.find(p => p.id === effectivePdfId)?.name ?? effectivePdfId
      const defaultName = `${pdfName.replace(/\.[^.]+$/, '')}-verification.pdf`
      const configuredDir = useSettingsStore.getState().settings.annotated_pdf_dir?.trim()

      let target: string | null
      if (configuredDir) {
        target = buildDefaultSavePath(configuredDir, defaultName)
      } else {
        target = await window.electronAPI.showSaveAs({
          title: t('verification.exportPdf'),
          defaultPath: defaultName,
          filters: [{ name: 'PDF Files', extensions: ['pdf'] }],
        })
      }
      if (!target) return

      // Respect the middle-pane sort order (sorted but unfiltered), and
      // exclude disabled references so the report reflects what the user
      // actually verified/kept.
      const sortedSourcesForExport = sortedSourceCards
        .filter(c => c.enabled)
        .map(c => c.source)
      const allVerifyTexts = useVerificationStore.getState().verifyTexts

      const reportSources = sortedSourcesForExport.map(s => {
        const r = pdfResults[s.id]
        const bm = r?.best_match
        const refText = allVerifyTexts[s.id] ?? s.text ?? ''
        // Prefer backend-provided URLs (built from NER-extracted title).
        // Fall back to local computation only when backend URLs aren't available.
        let scholarUrl = r?.scholar_url
        let googleUrl = r?.google_url
        if (!scholarUrl || !googleUrl) {
          const cacheKey = `${s.id}::${refText}`
          const extractedTitle = parsedTitles[cacheKey]?.trim() ?? ''
          const searchText = extractedTitle
            ? sanitizeReferenceTextForSearch(extractedTitle)
            : sanitizeReferenceTextForSearch(refText)
          if (!scholarUrl && searchText) scholarUrl = buildDbSearchUrl('Google Scholar', searchText)
          if (!googleUrl && searchText) googleUrl = googleSearchUrl(searchText)
        }
        return {
          refNumber: s.ref_number ?? 0,
          text: refText,
          status: r?.status ?? 'pending',
          problemTags: r?.problem_tags ?? [],
          trustTag: (r?.trust_tag ?? 'clean') as 'clean' | 'künye' | 'uydurma',
          trustTagOverride: (r?.trust_tag_override ?? null) as 'clean' | 'künye' | 'uydurma' | null,
          tagOverrides: r?.tag_overrides,
          scholarUrl,
          googleUrl,
          bestMatch: bm ? {
            title: bm.title,
            authors: bm.authors,
            year: bm.year,
            journal: bm.journal,
            doi: bm.doi,
            url: bm.url,
            database: bm.database,
            score: bm.score,
            titleSimilarity: bm.match_details?.title_similarity ?? 0,
            authorMatch: bm.match_details?.author_match ?? 0,
            yearMatch: bm.match_details?.year_match ?? 0,
          } : undefined,
        }
      })

      const baseSummary = summaries[effectivePdfId] ?? { found: 0, problematic: 0, not_found: 0, total: sortedSourcesForExport.length }
      const effectiveTrust = (r: typeof reportSources[number]) => r.trustTagOverride ?? r.trustTag
      const validCount = reportSources.filter(r => effectiveTrust(r) === 'clean').length
      const kunyeCount = reportSources.filter(r => effectiveTrust(r) === 'künye').length
      const uydurmaCount = reportSources.filter(r => effectiveTrust(r) === 'uydurma').length

      const { generateVerificationReport } = await import('../../pdf/verification-report-writer')
      const pdfBytes = await generateVerificationReport({
        pdfName,
        summary: { ...baseSummary, valid: validCount, kunye: kunyeCount, uydurma: uydurmaCount },
        sources: reportSources,
        labels: {
          header: t('verification.exportPdfHeader'),
          found: t('verification.status.found'),
          problematic: t('verification.status.problematic'),
          notFound: t('verification.status.not_found'),
          bestMatch: t('verification.exportPdfBestMatch'),
          problems: t('verification.exportPdfProblems'),
          noMatch: t('verification.exportPdfNoMatch'),
          references: t('verification.exportPdfReferences'),
          titleTag: t('verification.titleShort'),
          validTag: t('verification.validTag'),
          citationTag: t('verification.citationTag'),
          uydurmaTag: t('verification.uydurmaTag'),
          citationError: t('verification.exportPdfCitationError'),
          tagLabel: (tag: string) => problemTagLabel(tag),
        },
      })

      await window.electronAPI.writePdfFile(target, pdfBytes)
      setVerifyToast(t('verification.exportPdf'))
      if (verifyToastTimerRef.current) clearTimeout(verifyToastTimerRef.current)
      verifyToastTimerRef.current = setTimeout(() => setVerifyToast(null), VERIFY_TOAST_DURATION_MS)
    } catch (err) {
      console.error('[VerificationPage] report PDF export failed:', err)
      window.alert(`Export failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setExportingReport(false)
    }
  }

  async function openExternal(url: string) {
    try { await (window as any).electronAPI.openExternal(url) }
    catch { window.open(url, '_blank') }
  }

  const { selectSource, setVerifyText, resetVerifyText, toggleSourceEnabled, setAllEnabled } = useVerificationStore.getState()

  // Get progress for selected source (used in right panel for DB links)
  const selectedProgress = selectedSourceId ? sourceProgress[selectedSourceId] : undefined

  const [browserOverlayOpen, setBrowserOverlayOpen] = useState(false)
  const [browserOverlayUrl, setBrowserOverlayUrl] = useState('https://www.google.com/')
  const [browserOverlayHeight, setBrowserOverlayHeight] = useState(360)
  const browserOverlayRef = useRef<HTMLDivElement | null>(null)
  const [overlayResizing, setOverlayResizing] = useState(false)
  const overlayResizeStartRef = useRef<{ y: number; height: number } | null>(null)
  const browserWebviewRef = useRef<any>(null)
  const [browserCanGoBack, setBrowserCanGoBack] = useState(false)
  const [browserCanGoForward, setBrowserCanGoForward] = useState(false)
  const [browserCurrentUrl, setBrowserCurrentUrl] = useState('')
  const [browserZoomFactor, setBrowserZoomFactor] = useState(1)
  const browserZoomFactorRef = useRef(1)
  const preOverlaySortRef = useRef<{ key: CardSortMode; asc: boolean } | null>(null)

  // Find-in-page (Ctrl+F) state for the overlay webview
  const [findBarOpen, setFindBarOpen] = useState(false)
  const [findQuery, setFindQuery] = useState('')
  const [findActive, setFindActive] = useState(0)
  const [findTotal, setFindTotal] = useState(0)
  const findInputRef = useRef<HTMLInputElement | null>(null)
  const findBarOpenRef = useRef(false)
  useEffect(() => { findBarOpenRef.current = findBarOpen }, [findBarOpen])

  // Plain-Chrome UA so Cloudflare/WAFs (e.g. IEEE Xplore) don't 418 our
  // scholar-panel webviews for advertising "Electron/..." in the UA.
  const scholarPanelUserAgent =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

  // --- Scholar scan ---
  const scholarStatus = useScholarScanStore(s => s.status)
  const scholarCurrentIndex = useScholarScanStore(s => s.currentIndex)
  const scholarTotal = useScholarScanStore(s => s.totalInQueue)
  const scholarFoundCount = useScholarScanStore(s => s.foundCount)
  const scholarCaptchaUrl = useScholarScanStore(s => s.captchaUrl)
  const scholarQueue = useScholarScanStore(s => s.queue)
  const scholarLastDoneSourceId = useScholarScanStore(s => s.lastDoneSourceId)
  const scholarLastDoneUpdated = useScholarScanStore(s => s.lastDoneUpdated)

  // Derive human-readable scan context for the bottom banner.
  const scholarBannerInfo = useMemo(() => {
    const clampedIdx = Math.min(scholarCurrentIndex, Math.max(0, scholarQueue.length - 1))
    const currentItem = scholarQueue[clampedIdx]
    const currentPdf = currentItem ? allPdfs.find(p => p.id === currentItem.pdfId) : undefined
    const currentSource = currentItem
      ? (sourcesByPdf[currentItem.pdfId] ?? []).find(s => s.id === currentItem.sourceId)
      : undefined
    const lastItem = scholarLastDoneSourceId
      ? scholarQueue.find(q => q.sourceId === scholarLastDoneSourceId)
      : undefined
    const lastSource = lastItem
      ? (sourcesByPdf[lastItem.pdfId] ?? []).find(s => s.id === lastItem.sourceId)
      : undefined
    return {
      pdfName: currentPdf?.name ?? null,
      refNumber: currentSource?.ref_number ?? null,
      lastRefNumber: lastSource?.ref_number ?? null,
      lastUpdated: scholarLastDoneUpdated,
    }
  }, [scholarQueue, scholarCurrentIndex, scholarLastDoneSourceId, scholarLastDoneUpdated, allPdfs, sourcesByPdf])

  // Show deferred verification-complete toast after Scholar scan finishes.
  useEffect(() => {
    if ((scholarStatus === 'done' || scholarStatus === 'cancelled') && deferredToastNameRef.current) {
      const name = deferredToastNameRef.current
      deferredToastNameRef.current = null
      if (verifyToastTimerRef.current) clearTimeout(verifyToastTimerRef.current)
      setVerifyToast(t('verification.verificationComplete', { name }))
      verifyToastTimerRef.current = setTimeout(() => setVerifyToast(null), VERIFY_TOAST_DURATION_MS)
    }
  }, [scholarStatus])

  // Wire the hidden webview to the scanner via callback ref
  const scholarScanWebviewRef = useCallback((node: any) => {
    scholarScanner.setWebview(node)
  }, [])

  // Keep overlay webview ref in sync with the scanner — but never overwrite
  // with null when it unmounts, so the scanner can still extract even if the
  // user closes the overlay before auto-resume fires.
  useEffect(() => {
    if (browserWebviewRef.current) {
      scholarScanner.setOverlayWebview(browserWebviewRef.current)
    }
  })

  // Register close-overlay function for auto-close after CAPTCHA
  useEffect(() => {
    useScholarScanStore.getState().setCloseOverlayFn(() => {
      setBrowserOverlayOpen(false)
    })
    return () => useScholarScanStore.getState().setCloseOverlayFn(null)
  }, [])

  // When CAPTCHA is detected, open the overlay with the CAPTCHA URL.
  // Height is handled by getOverlayPreferredHeight, which returns the full
  // max during CAPTCHA so the reCAPTCHA grid is fully visible.
  useEffect(() => {
    if (scholarStatus === 'captcha' && scholarCaptchaUrl) {
      openOverlayWithUrl(scholarCaptchaUrl)
    }
  }, [scholarStatus, scholarCaptchaUrl])

  // Manual Resume: confirm the overlay is on a Scholar results page before
  // resuming, so an accidental click on the still-visible CAPTCHA page does
  // not advance the queue with empty results. If the overlay is unreachable,
  // we still resume — the scanner will fall back to the hidden webview.
  const handleResumeClick = useCallback(async () => {
    const view = browserWebviewRef.current
    const showSolveFirstToast = (): void => {
      if (verifyToastTimerRef.current) clearTimeout(verifyToastTimerRef.current)
      setVerifyToast(t('verification.scholarSolveFirst'))
      verifyToastTimerRef.current = setTimeout(() => setVerifyToast(null), VERIFY_TOAST_DURATION_MS)
    }
    if (view) {
      try {
        const state = await view.executeJavaScript(PROBE_PAGE_STATE_SCRIPT)
        const ready = state?.ready === 'complete' || state?.ready === 'interactive'
        if (!state || state.hasCaptcha || !state.hasResults || !ready) {
          showSolveFirstToast()
          return
        }
      } catch (err) {
        // Overlay not responsive — proceed; the scanner's fallback handles it.
        // Logged so this path leaves a breadcrumb if it ever misbehaves.
        console.warn('[Scholar] Resume probe failed; proceeding to scanner fallback:', err)
      }
    }
    useScholarScanStore.getState().resumeAfterCaptcha()
  }, [t])

  // Auto-resume: detect when overlay navigates to a Scholar results page (CAPTCHA solved)
  useEffect(() => {
    if (scholarStatus !== 'captcha') return
    if (!browserOverlayOpen) return
    const view = browserWebviewRef.current
    if (!view) return

    let resumed = false

    const checkCaptchaSolved = async (): Promise<void> => {
      if (resumed) return
      try {
        const url: string = await view.executeJavaScript('window.location.href')
        if (!url.includes('scholar.google.com')) return
        if (url.includes('sorry.google.com')) return

        // Require a POSITIVE signal that the results page has rendered, not
        // merely the absence of a CAPTCHA element. Otherwise an in-flight
        // navigation (empty document) reads as "solved" and we auto-resume
        // while the webview is still loading the CAPTCHA page.
        const state = await view.executeJavaScript(PROBE_PAGE_STATE_SCRIPT)
        if (!state || state.hasCaptcha || !state.hasResults) return
        if (state.ready !== 'complete' && state.ready !== 'interactive') return

        // console.log('[Scholar] CAPTCHA solved detected, auto-resuming')
        resumed = true
        useScholarScanStore.getState().resumeAfterCaptcha()
      } catch {
        // webview might not be ready
      }
    }

    const onPageLoaded = (): void => {
      // Wait for page to fully render before checking
      setTimeout(checkCaptchaSolved, 2000)
    }

    view.addEventListener('did-navigate', onPageLoaded)
    view.addEventListener('did-navigate-in-page', onPageLoaded)
    view.addEventListener('did-stop-loading', onPageLoaded)
    return () => {
      try {
        view.removeEventListener('did-navigate', onPageLoaded)
        view.removeEventListener('did-navigate-in-page', onPageLoaded)
        view.removeEventListener('did-stop-loading', onPageLoaded)
      } catch {}
    }
  }, [scholarStatus, browserOverlayOpen])

  const selectedSearchText = useMemo(() => {
    if (!selectedSourceId) return ''
    const text = verifyTexts[selectedSourceId] ?? currentSource?.text ?? ''
    return sanitizeReferenceTextForSearch(text)
  }, [selectedSourceId, verifyTexts, currentSource])

  // Titles parsed from each source's raw reference text via the NER extractor.
  // Keyed by `${sourceId}::${rawText}` so edits to the reference text trigger a
  // re-extraction instead of returning a stale cached title.
  const [parsedTitles, setParsedTitles] = useState<Record<string, string>>({})

  useEffect(() => {
    if (!selectedSourceId) return
    const rawText = verifyTexts[selectedSourceId] ?? currentSource?.text ?? ''
    if (!rawText.trim()) return
    const key = `${selectedSourceId}::${rawText}`
    if (parsedTitles[key] !== undefined) return
    let cancelled = false
    ;(async () => {
      try {
        const parsed = await api.extractFields(rawText)
        if (cancelled) return
        setParsedTitles(prev => ({ ...prev, [key]: parsed?.title?.trim() ?? '' }))
      } catch {
        if (cancelled) return
        setParsedTitles(prev => ({ ...prev, [key]: '' }))
      }
    })()
    return () => { cancelled = true }
  }, [selectedSourceId, verifyTexts, currentSource, parsedTitles])

  const selectedParsedTitle = useMemo(() => {
    if (!selectedSourceId) return ''
    const rawText = verifyTexts[selectedSourceId] ?? currentSource?.text ?? ''
    const key = `${selectedSourceId}::${rawText}`
    return parsedTitles[key] ?? ''
  }, [selectedSourceId, verifyTexts, currentSource, parsedTitles])

  // External searches (Google Scholar / Google Search / DB result links) use
  // the title parsed from the raw reference text — falling back to the raw
  // reference text itself when no parsed title is available yet.
  const selectedTitleOrText = useMemo(() => {
    const title = selectedParsedTitle.trim()
    if (title) return sanitizeReferenceTextForSearch(title)
    return selectedSearchText
  }, [selectedParsedTitle, selectedSearchText])

  // The true max is driven purely by the panel's usable height so the overlay
  // never collapses to its min when the selected card sits near the bottom of
  // the list (scroll-to-top can't always lift it to the top when the list has
  // insufficient scrollable room below the card).
  function getOverlayMaxHeight(): number {
    const minHeight = 220
    const topMargin = 80
    const panelHeight = verifyCenterRef.current?.clientHeight ?? window.innerHeight
    return Math.max(minHeight, panelHeight - topMargin)
  }

  // Preferred opening height: try to leave the selected card visible above the
  // overlay. In the happy path, scrollSelectedCardToTop lifts the card to near
  // the top of the panel, so `preferred` is large (close to maxHeight). The
  // edge cases — filtered-list mismatch in the re-sort heuristic, or a list
  // too short to scroll the card to the top — would otherwise produce a tiny
  // preferred value; in those cases we give up on card-visibility and fall
  // back to maxHeight so the overlay is still usable.
  function getOverlayPreferredHeight(): number {
    const maxHeight = getOverlayMaxHeight()
    // During a Scholar CAPTCHA the reCAPTCHA grid is taller than the card-aware
    // preferred size, and the user isn't focused on any specific card —
    // always open at the full max so the whole challenge is visible.
    if (scholarStatus === 'captcha') return maxHeight
    const centerEl = verifyCenterRef.current
    if (!centerEl || !selectedSourceId) return maxHeight

    const cardEl = cardRefs.current[selectedSourceId]
    if (!cardEl) return maxHeight

    const panelRect = centerEl.getBoundingClientRect()
    const cardRect = cardEl.getBoundingClientRect()
    const cardBottomFromPanelTop = cardRect.bottom - panelRect.top + 8
    const panelHeight = centerEl.clientHeight

    // Card out of view — card-aware sizing is meaningless.
    if (cardBottomFromPanelTop <= 0 || cardBottomFromPanelTop >= panelHeight) {
      return maxHeight
    }

    const preferred = panelHeight - cardBottomFromPanelTop
    // If the card ends up in the bottom half of the panel, the scroll-to-top
    // mitigation didn't land — falling back to maxHeight covers the card but
    // keeps the overlay usable instead of opening it at e.g. 40px.
    if (preferred < maxHeight / 2) return maxHeight
    return Math.min(maxHeight, preferred)
  }

  const selectedCardIndex = useMemo(
    () => (selectedSourceId ? sortedSourceCards.findIndex(c => c.source.id === selectedSourceId) : -1),
    [selectedSourceId, sortedSourceCards],
  )

  const scrollSelectedCardToTop = useCallback((behavior: ScrollBehavior = 'auto') => {
    if (!selectedSourceId) return
    const listEl = cardListRef.current
    const cardEl = cardRefs.current[selectedSourceId]
    if (!cardEl) return

    if (!listEl || !listEl.contains(cardEl)) {
      cardEl.scrollIntoView({ behavior, block: 'start', inline: 'nearest' })
      return
    }

    const nextTop = Math.max(0, cardEl.offsetTop - listEl.offsetTop - 2)
    listEl.scrollTo({ top: nextTop, behavior })
  }, [selectedSourceId])

  const scrollCardIntoView = useCallback((id: string, behavior: ScrollBehavior = 'smooth') => {
    const listEl = cardListRef.current
    const cardEl = cardRefs.current[id]
    if (!cardEl) return
    if (!listEl || !listEl.contains(cardEl)) {
      cardEl.scrollIntoView({ behavior, block: 'nearest', inline: 'nearest' })
      return
    }
    const listRect = listEl.getBoundingClientRect()
    const cardRect = cardEl.getBoundingClientRect()
    if (cardRect.top >= listRect.top && cardRect.bottom <= listRect.bottom) return
    const nextTop = cardEl.offsetTop - listEl.offsetTop - (listEl.clientHeight - cardEl.offsetHeight) / 2
    listEl.scrollTo({ top: Math.max(0, nextTop), behavior })
  }, [])

  // After a status-changing action reorders the sorted list, scroll the
  // modified card back into view so the user doesn't lose track of it.
  useEffect(() => {
    const id = pendingScrollCardIdRef.current
    if (!id) return
    pendingScrollCardIdRef.current = null
    const raf = requestAnimationFrame(() => scrollCardIntoView(id, 'smooth'))
    return () => cancelAnimationFrame(raf)
  }, [filteredSourceCards, scrollCardIntoView])

  // Right-click-on-PDF jump: after selectPdf swaps the source list, select the
  // target source and scroll its card into view once it's mounted.
  useEffect(() => {
    const pending = pendingJumpRef.current
    if (!pending) return
    if (pending.pdfId !== effectivePdfId) return
    const raf = requestAnimationFrame(() => {
      if (!cardRefs.current[pending.sourceId]) return
      useVerificationStore.getState().selectSource(pending.sourceId)
      scrollCardIntoView(pending.sourceId, 'smooth')
      pendingJumpRef.current = null
    })
    return () => cancelAnimationFrame(raf)
  }, [effectivePdfId, sortedSourceCards, scrollCardIntoView])

  function alignOverlayToSelectedCard() {
    if (!selectedSourceId) {
      // Still size the overlay to its max even when no card is selected
      // (e.g. Scholar CAPTCHA opens the overlay mid-scan).
      window.requestAnimationFrame(() => {
        setBrowserOverlayHeight(getOverlayMaxHeight())
      })
      return
    }
    scrollSelectedCardToTop('auto')

    window.requestAnimationFrame(() => {
      setBrowserOverlayHeight(getOverlayPreferredHeight())
    })
  }

  function shouldUseTemporaryRefSortForBottomCard(): boolean {
    if (selectedCardIndex < 0) return false
    const total = sortedSourceCards.length
    if (total <= 0) return false
    return selectedCardIndex >= Math.max(0, total - 5)
  }

  function applyTemporaryRefSortIfNeeded(): boolean {
    if (!shouldUseTemporaryRefSortForBottomCard()) return false
    if (preOverlaySortRef.current) return true

    preOverlaySortRef.current = {
      key: cardSortKey as CardSortMode,
      asc: cardSortAsc,
    }

    useVerificationStore.setState({
      cardSortKey: 'ref',
      cardSortAsc: false,
    })

    return true
  }

  function restorePreOverlaySortIfNeeded() {
    const snapshot = preOverlaySortRef.current
    if (!snapshot) return
    preOverlaySortRef.current = null
    useVerificationStore.setState({
      cardSortKey: snapshot.key,
      cardSortAsc: snapshot.asc,
    })
  }

  function openOverlayWithUrl(url: string) {
    const tempSorted = applyTemporaryRefSortIfNeeded()
    const finishOpen = () => {
      alignOverlayToSelectedCard()
      setBrowserOverlayUrl(url)
      setBrowserCurrentUrl(url)
      setBrowserOverlayOpen(true)
    }

    if (tempSorted) {
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(finishOpen)
      })
      return
    }

    finishOpen()
  }

  function openScholarOverlay() {
    // Prefer the backend-provided URL (built from NER-extracted title) to
    // avoid the race where the frontend hasn't finished NER extraction yet.
    const backendUrl = currentResult?.scholar_url
    const url = backendUrl
      || (selectedTitleOrText ? buildSearchUrl(selectedTitleOrText) : 'https://scholar.google.com/')
    openOverlayWithUrl(url)
  }

  function openGoogleOverlay() {
    const backendUrl = currentResult?.google_url
    const url = backendUrl
      || (selectedTitleOrText ? googleSearchUrl(selectedTitleOrText) : 'https://www.google.com/')
    openOverlayWithUrl(url)
  }

  function closeBrowserOverlay() {
    setBrowserOverlayOpen(false)
  }

  const runFindInPage = useCallback((text: string, opts?: { findNext?: boolean; forward?: boolean }) => {
    const view = browserWebviewRef.current
    if (!view) return
    if (!text) {
      try { view.stopFindInPage?.('clearSelection') } catch { /* ignore */ }
      setFindActive(0)
      setFindTotal(0)
      return
    }
    const forward = opts?.forward ?? true
    try {
      // findNext: false starts a new search session but does not always
      // activate/scroll to a match on its own. Follow up with findNext: true
      // so the first match becomes active and scrolls into view.
      if (opts?.findNext) {
        view.findInPage?.(text, { findNext: true, forward })
      } else {
        view.findInPage?.(text, { findNext: false, forward })
        view.findInPage?.(text, { findNext: true, forward })
      }
    } catch {
      // ignore find errors
    }
  }, [])

  const openFindBar = useCallback(() => {
    setFindBarOpen(true)
    requestAnimationFrame(() => {
      const input = findInputRef.current
      if (!input) return
      input.focus()
      input.select()
    })
  }, [])

  const closeFindBar = useCallback(() => {
    setFindBarOpen(false)
    setFindQuery('')
    setFindActive(0)
    setFindTotal(0)
    const view = browserWebviewRef.current
    try { view?.stopFindInPage?.('clearSelection') } catch { /* ignore */ }
  }, [])

  const navigateFind = useCallback((forward: boolean) => {
    if (!findQuery) return
    runFindInPage(findQuery, { findNext: true, forward })
  }, [findQuery, runFindInPage])

  function syncBrowserNavState() {
    const view = browserWebviewRef.current
    if (!view) {
      setBrowserCanGoBack(false)
      setBrowserCanGoForward(false)
      setBrowserCurrentUrl(browserOverlayUrl)
      return
    }
    try {
      setBrowserCanGoBack(Boolean(view.canGoBack?.()))
      setBrowserCanGoForward(Boolean(view.canGoForward?.()))
      const url = view.getURL?.()
      if (typeof url === 'string' && url) setBrowserCurrentUrl(url)
    } catch {
      setBrowserCanGoBack(false)
      setBrowserCanGoForward(false)
    }
  }

  const clampBrowserZoom = useCallback((nextZoom: number): number => {
    return Math.min(MAX_BROWSER_ZOOM, Math.max(MIN_BROWSER_ZOOM, nextZoom))
  }, [])

  const syncBrowserZoomState = useCallback(() => {
    const view = browserWebviewRef.current
    if (!view) {
      browserZoomFactorRef.current = 1
      setBrowserZoomFactor(1)
      return
    }
    try {
      const maybeZoom = view.getZoomFactor?.()
      if (typeof maybeZoom === 'number') {
        const clamped = clampBrowserZoom(maybeZoom)
        browserZoomFactorRef.current = clamped
        setBrowserZoomFactor(clamped)
        return
      }
      if (maybeZoom && typeof maybeZoom.then === 'function') {
        void maybeZoom
          .then((zoom: number) => {
            const clamped = clampBrowserZoom(zoom)
            browserZoomFactorRef.current = clamped
            setBrowserZoomFactor(clamped)
          })
          .catch(() => {})
      }
    } catch {
      // ignore webview zoom state errors
    }
  }, [clampBrowserZoom])

  const applyBrowserZoom = useCallback((nextZoom: number) => {
    const clamped = clampBrowserZoom(nextZoom)
    const view = browserWebviewRef.current
    try {
      view?.setZoomFactor?.(clamped)
    } catch {
      // ignore webview zoom errors
    }
    browserZoomFactorRef.current = clamped
    setBrowserZoomFactor(clamped)
  }, [clampBrowserZoom])

  const zoomBrowserIn = useCallback(() => {
    applyBrowserZoom(browserZoomFactorRef.current * BROWSER_ZOOM_STEP)
  }, [applyBrowserZoom])

  const zoomBrowserOut = useCallback(() => {
    applyBrowserZoom(browserZoomFactorRef.current / BROWSER_ZOOM_STEP)
  }, [applyBrowserZoom])

  const resetBrowserZoom = useCallback(() => {
    applyBrowserZoom(1)
  }, [applyBrowserZoom])

  function goBrowserBack() {
    const view = browserWebviewRef.current
    if (!view) return
    try {
      if (view.canGoBack?.()) view.goBack()
      syncBrowserNavState()
    } catch {
      // ignore webview navigation errors
    }
  }

  function goBrowserForward() {
    const view = browserWebviewRef.current
    if (!view) return
    try {
      if (view.canGoForward?.()) view.goForward()
      syncBrowserNavState()
    } catch {
      // ignore webview navigation errors
    }
  }

  function reloadBrowserView() {
    const view = browserWebviewRef.current
    if (!view) return
    try {
      view.reload?.()
    } catch {
      // ignore webview navigation errors
    }
  }

  function clampOverlayHeight(nextHeight: number): number {
    // Floor = actual chrome above the webview (resizer + header + optional
    // CAPTCHA banner). Measured from the DOM so it stays correct when the
    // banner appears/disappears, with a 40px fallback for the first render.
    const overlayEl = browserOverlayRef.current
    const webviewWrap = overlayEl?.querySelector<HTMLElement>(`.${styles['scholar-overlay-webview-wrap']}`)
    const minHeight = webviewWrap?.offsetTop ?? 40
    const maxHeight = getOverlayMaxHeight()
    return Math.min(maxHeight, Math.max(minHeight, nextHeight))
  }

  function startOverlayResize(e: React.MouseEvent<HTMLDivElement>) {
    e.preventDefault()
    overlayResizeStartRef.current = { y: e.clientY, height: browserOverlayHeight }
    setOverlayResizing(true)
  }

  function maximizeOverlay() {
    // Use the same card-aware sizing as the initial open: normally leaves the
    // selected card visible above the overlay, and short-circuits to full max
    // during CAPTCHA or when no card is focused.
    scrollSelectedCardToTop('auto')
    window.requestAnimationFrame(() => {
      setBrowserOverlayHeight(getOverlayPreferredHeight())
    })
  }

  // "Collapsed" = user has dragged the overlay down to just the chrome strip,
  // so the webview area is effectively gone. Chrome height is resizer + header
  // (+ optional captcha banner); below ~40px of webview visible, we swap the
  // zoom controls out for a maximize button.
  const isOverlayCollapsed = (() => {
    const overlayEl = browserOverlayRef.current
    const webviewWrap = overlayEl?.querySelector<HTMLElement>(`.${styles['scholar-overlay-webview-wrap']}`)
    const chromeHeight = webviewWrap?.offsetTop ?? (scholarStatus === 'captcha' ? 96 : 66)
    return browserOverlayHeight - chromeHeight < 40
  })()

  useEffect(() => {
    if (!browserOverlayOpen) return
    alignOverlayToSelectedCard()
  }, [browserOverlayOpen, selectedSourceId])

  useEffect(() => {
    if (!browserOverlayOpen) return
    const onResize = () => setBrowserOverlayHeight((h) => clampOverlayHeight(h))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [browserOverlayOpen])

  useEffect(() => {
    if (!browserOverlayOpen) return
    // Don't force-close during a Scholar CAPTCHA — the scan isn't tied to
    // the currently selected card, so selectedSourceId may legitimately be null.
    if (scholarStatus === 'captcha') return
    if (!selectedSourceId) setBrowserOverlayOpen(false)
  }, [browserOverlayOpen, selectedSourceId, scholarStatus])

  useEffect(() => {
    if (browserOverlayOpen) return
    // Bottom-of-list cards get a temporary ref-desc sort on overlay open so
    // they can be scrolled to the top behind the webview. On close, restoring
    // the original sort drops the card back near the bottom of an unscrolled
    // list — queue a scroll-into-view so the user doesn't lose it.
    if (preOverlaySortRef.current && selectedSourceId) {
      pendingScrollCardIdRef.current = selectedSourceId
    }
    restorePreOverlaySortIfNeeded()
  }, [browserOverlayOpen])

  useEffect(() => {
    if (!browserOverlayOpen) {
      setBrowserCanGoBack(false)
      setBrowserCanGoForward(false)
      browserZoomFactorRef.current = 1
      setBrowserZoomFactor(1)
      return
    }

    const view = browserWebviewRef.current
    if (!view) return

    const onViewStateChange = () => {
      syncBrowserNavState()
      syncBrowserZoomState()
    }

    // Inject zoom + find + nav handlers into webview content so keyboard and
    // mouse shortcuts work when focus is inside the guest page. Events are
    // relayed back via console.log sentinels.
    const injectZoomScript = () => {
      try {
        view.executeJavaScript?.(`
          (function() {
            if (window.__zoomInjected) return;
            window.__zoomInjected = true;
            document.addEventListener('wheel', function(e) {
              if (e.ctrlKey || e.metaKey) {
                e.preventDefault();
                console.log(e.deltaY > 0 ? '__ZOOM_OUT__' : '__ZOOM_IN__');
              }
            }, { passive: false });
            document.addEventListener('keydown', function(e) {
              if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'f' || e.key === 'F')) {
                e.preventDefault();
                e.stopPropagation();
                console.log('__FIND_OPEN__');
              } else if (e.key === 'Escape') {
                console.log('__OVERLAY_ESC__');
              } else if (e.key === 'F5') {
                e.preventDefault();
                e.stopPropagation();
                console.log('__OVERLAY_RELOAD__');
              }
            }, true);
            document.addEventListener('mousedown', function(e) {
              if (e.button === 3) {
                e.preventDefault();
                console.log('__OVERLAY_BACK__');
              } else if (e.button === 4) {
                e.preventDefault();
                console.log('__OVERLAY_FORWARD__');
              }
            }, true);
            document.addEventListener('auxclick', function(e) {
              // Some browsers fire auxclick for thumb buttons even after
              // mousedown preventDefault — still block default navigation.
              if (e.button === 3 || e.button === 4) e.preventDefault();
            }, true);
          })();
        `)
      } catch {
        // ignore injection errors
      }
    }

    const onDomReady = () => {
      injectZoomScript()
      onViewStateChange()
    }

    const onConsoleMessage = (event: any) => {
      const msg = event?.message
      if (msg === '__ZOOM_IN__') zoomBrowserIn()
      else if (msg === '__ZOOM_OUT__') zoomBrowserOut()
      else if (msg === '__FIND_OPEN__') openFindBar()
      else if (msg === '__OVERLAY_ESC__') {
        if (findBarOpenRef.current) closeFindBar()
        else closeBrowserOverlay()
      }
      else if (msg === '__OVERLAY_RELOAD__') reloadBrowserView()
      else if (msg === '__OVERLAY_BACK__') goBrowserBack()
      else if (msg === '__OVERLAY_FORWARD__') goBrowserForward()
    }

    const onFoundInPage = (event: any) => {
      const r = event?.result
      if (!r) return
      if (typeof r.matches === 'number') setFindTotal(r.matches)
      if (typeof r.activeMatchOrdinal === 'number') setFindActive(r.activeMatchOrdinal)
    }

    view.addEventListener('did-navigate', onViewStateChange)
    view.addEventListener('did-navigate-in-page', onViewStateChange)
    view.addEventListener('did-stop-loading', onDomReady)
    view.addEventListener('dom-ready', onDomReady)
    view.addEventListener('console-message', onConsoleMessage)
    view.addEventListener('found-in-page', onFoundInPage)

    const timer = window.setTimeout(onDomReady, 100)

    return () => {
      window.clearTimeout(timer)
      view.removeEventListener('did-navigate', onViewStateChange)
      view.removeEventListener('did-navigate-in-page', onViewStateChange)
      view.removeEventListener('did-stop-loading', onDomReady)
      view.removeEventListener('dom-ready', onDomReady)
      view.removeEventListener('console-message', onConsoleMessage)
      view.removeEventListener('found-in-page', onFoundInPage)
    }
  }, [browserOverlayOpen, browserOverlayUrl, selectedSourceId, syncBrowserZoomState, zoomBrowserIn, zoomBrowserOut, openFindBar, closeFindBar])

  useEffect(() => {
    if (!browserOverlayOpen) return

    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault()
        openFindBar()
        return
      }

      if (e.key === 'Escape') {
        e.preventDefault()
        if (findBarOpen) closeFindBar()
        else closeBrowserOverlay()
        return
      }

      if (e.key === 'F5') {
        e.preventDefault()
        reloadBrowserView()
        return
      }

      if (!(e.ctrlKey || e.metaKey) || e.altKey) return

      if (e.key === '+' || e.key === '=' || e.code === 'NumpadAdd') {
        e.preventDefault()
        zoomBrowserIn()
        return
      }

      if (e.key === '-' || e.key === '_' || e.code === 'NumpadSubtract') {
        e.preventDefault()
        zoomBrowserOut()
        return
      }

      if (e.key === '0' || e.code === 'Digit0' || e.code === 'Numpad0') {
        e.preventDefault()
        resetBrowserZoom()
      }
    }

    // Mouse thumb buttons: button 3 = back, button 4 = forward.
    // Events over the webview itself are captured by the guest process
    // (which natively navigates its own history — same outcome), so this
    // listener handles clicks over the header, banner, and surrounding chrome.
    const onMouseDown = (e: MouseEvent) => {
      if (e.button === 3) {
        e.preventDefault()
        goBrowserBack()
      } else if (e.button === 4) {
        e.preventDefault()
        goBrowserForward()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('mousedown', onMouseDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('mousedown', onMouseDown)
    }
  }, [browserOverlayOpen, zoomBrowserIn, zoomBrowserOut, resetBrowserZoom, findBarOpen, openFindBar, closeFindBar])

  // Clear find state when overlay closes or navigates to a new URL.
  useEffect(() => {
    if (!browserOverlayOpen) {
      setFindBarOpen(false)
      setFindQuery('')
      setFindActive(0)
      setFindTotal(0)
    }
  }, [browserOverlayOpen])

  useEffect(() => {
    setFindActive(0)
    setFindTotal(0)
  }, [browserOverlayUrl])

  useEffect(() => {
    if (!browserOverlayOpen) return

    const overlay = browserOverlayRef.current

    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      if (overlay && !overlay.contains(e.target as Node)) return
      e.preventDefault()
      if (e.deltaY > 0) zoomBrowserOut()
      if (e.deltaY < 0) zoomBrowserIn()
    }

    overlay?.addEventListener('wheel', onWheel, { passive: false })
    window.addEventListener('wheel', onWheel, { passive: false, capture: true })
    return () => {
      overlay?.removeEventListener('wheel', onWheel)
      window.removeEventListener('wheel', onWheel, true)
    }
  }, [browserOverlayOpen, browserOverlayUrl, zoomBrowserIn, zoomBrowserOut])

  useEffect(() => {
    if (!overlayResizing) return

    const onMouseMove = (e: MouseEvent) => {
      const start = overlayResizeStartRef.current
      if (!start) return
      // A stray mousemove with no button pressed means we missed the mouseup
      // (e.g. release happened over the webview's guest process or outside
      // the window). Cancel the drag instead of letting it follow the cursor.
      if (e.buttons === 0) {
        setOverlayResizing(false)
        overlayResizeStartRef.current = null
        return
      }
      const delta = start.y - e.clientY
      setBrowserOverlayHeight(clampOverlayHeight(start.height + delta))
    }

    const stopResize = () => {
      setOverlayResizing(false)
      overlayResizeStartRef.current = null
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', stopResize)
    window.addEventListener('blur', stopResize)

    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', stopResize)
      window.removeEventListener('blur', stopResize)
    }
  }, [overlayResizing])

  useEffect(() => {
    if (!cutoffDragging) return

    const computeSlotFromY = (clientY: number): number => {
      const n = sortedPdfs.length
      if (n === 0) return 0
      for (let i = 0; i < n; i++) {
        const el = pdfItemRefs.current.get(sortedPdfs[i].id)
        if (!el) continue
        const r = el.getBoundingClientRect()
        if (clientY < r.top + r.height / 2) return i
      }
      return n
    }

    const onMouseMove = (e: MouseEvent) => {
      if (e.buttons === 0) {
        setCutoffDragging(false)
        return
      }
      setVerifyCutoffIndex(computeSlotFromY(e.clientY))
    }
    const stop = () => setCutoffDragging(false)

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', stop)
    window.addEventListener('blur', stop)
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', stop)
      window.removeEventListener('blur', stop)
    }
  }, [cutoffDragging, sortedPdfs, setVerifyCutoffIndex])

  return (
    <div className={styles['verify-page']}>
      {/* Verification completion toast */}
      {verifyToast && (
        <div className={styles['verify-toast']} onClick={() => setVerifyToast(null)}>
          <span className={styles['verify-toast-inner']}>{verifyToast}</span>
        </div>
      )}

      {/* Left Panel: PDF List */}
      <aside className={styles['verify-left']} onMouseDownCapture={() => browserOverlayOpen && closeBrowserOverlay()}>
        <div className={styles['panel-header']}>
          <h2 className={styles['panel-title']}>{t('verification.title')}</h2>
          <div className={styles['start-split']} ref={verifyAllMenuRef}>
            <button
              className={`${styles['start-btn']} ${styles['start-btn-main']}`}
              onClick={() => handleStartOrCancel(lastVerifyAllMode)}
              disabled={pdfs.length === 0 || (!isAnyVerifying && !verifyAllActive && Math.min(verifyCutoffIndex, sortedPdfs.length) === 0)}
            >
              {(isAnyVerifying || verifyAllActive) ? <><span>&#x25A0;</span> {t('verification.stop')}</> : <><span>&#x25B6;</span> {t('verification.verifyAll')}</>}
            </button>
            {!(isAnyVerifying || verifyAllActive) && (
              <button
                type="button"
                className={`${styles['start-btn']} ${styles['start-btn-caret']}`}
                onClick={() => setVerifyAllMenuOpen(o => !o)}
                disabled={pdfs.length === 0 || Math.min(verifyCutoffIndex, sortedPdfs.length) === 0}
                aria-haspopup="menu"
                aria-expanded={verifyAllMenuOpen}
                aria-label={t('verification.verifyAllMenu')}
                title={t('verification.verifyAllMenu')}
              >
                {'▾'}
              </button>
            )}
            {verifyAllMenuOpen && (
              <ul className={styles['start-menu']} role="menu">
                {(['all', 'nonFound'] as const).map(mode => (
                  <li key={mode} role="none">
                    <button
                      type="button"
                      role="menuitem"
                      className={lastVerifyAllMode === mode ? styles['sort-active'] : ''}
                      onClick={() => {
                        setLastVerifyAllMode(mode)
                        setVerifyAllMenuOpen(false)
                        void handleStartOrCancel(mode)
                      }}
                    >
                      {t(`verification.verifyAllModes.${mode}`)}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {pdfs.length > 0 && (
          <div className={styles['verify-sort-bar']}>
            <button className={`${styles['sort-btn']} ${styles['sort-btn-status']} ${pdfSortKey === 'status' ? styles['sort-active'] : ''}`} onClick={() => togglePdfSort('status')} title={t('verification.sort.byStatus')}>
              &#x25CF;{pdfSortKey === 'status' && <span className={styles['sort-arrow']}>{pdfSortAsc ? '\u2191' : '\u2193'}</span>}
            </button>
            <button className={`${styles['sort-btn']} ${styles['sort-btn-grow']} ${pdfSortKey === 'name' ? styles['sort-active'] : ''}`} onClick={() => togglePdfSort('name')} title={t('verification.sort.byName')}>
              {t('verification.sort.name')}{pdfSortKey === 'name' && <span className={styles['sort-arrow']}>{pdfSortAsc ? '\u2191' : '\u2193'}</span>}
            </button>
            {([
              { key: 'found',       color: STATUS_HEX.found,         titleKey: 'verification.sort.byFound' },
              { key: 'problematic', color: STATUS_HEX.problematic,   titleKey: 'verification.sort.byProblematic' },
              { key: 'not_found',   color: STATUS_HEX.not_found,     titleKey: 'verification.sort.byNotFound' },
              { key: 'valid',       color: TRUST_HEX.validBorder,    titleKey: 'verification.sort.byValid' },
              { key: 'kunye',       color: TRUST_HEX.kunyeBorder,    titleKey: 'verification.sort.byKunye' },
              { key: 'uydurma',     color: TRUST_HEX.uydurmaBorder,  titleKey: 'verification.sort.byUydurma' },
            ] as const).map(({ key, color, titleKey }) => (
              <button
                key={key}
                className={`${styles['sort-btn']} ${pdfSortKey === key ? styles['sort-active'] : ''}`}
                onClick={() => togglePdfSort(key)}
                title={t(titleKey)}
              >
                <span className={styles['sort-swatch']} style={{ ['--swatch-color' as string]: color } as React.CSSProperties} aria-hidden="true" />
                {pdfSortKey === key && <span className={styles['sort-arrow']}>{pdfSortAsc ? '\u2191' : '\u2193'}</span>}
              </button>
            ))}
          </div>
        )}

        <div className={styles['verify-list']}>
          {pdfs.length === 0 ? (
            <div className={styles['empty-state']}>
              <p>{t('verification.noApprovedPdfs')}</p>
              <p className={styles['empty-sub']}>{t('verification.approveFirst')}</p>
            </div>
          ) : (() => {
            const effectiveCutoff = Math.min(verifyCutoffIndex, sortedPdfs.length)
            const renderDivider = () => (
              <div
                key="__verify-cutoff__"
                className={`${styles['verify-divider']} ${cutoffDragging ? styles['verify-divider-dragging'] : ''}`}
                onMouseDown={startCutoffDrag}
                title={t('verification.cutoff.dragHint')}
                role="separator"
                aria-orientation="horizontal"
              >
                <span className={styles['verify-divider-line']} />
                <span className={styles['verify-divider-label']}>
                  {effectiveCutoff >= sortedPdfs.length
                    ? t('verification.cutoff.labelAll')
                    : t('verification.cutoff.labelPartial', { count: effectiveCutoff })}
                </span>
              </div>
            )
            const nodes: React.ReactNode[] = []
            sortedPdfs.forEach((pdf, i) => {
              if (i === effectiveCutoff) nodes.push(renderDivider())
              const summary = summaries[pdf.id]
              const pdfVerifying = isPdfVerifying(pdf.id)
              const pdfResults = resultsByPdf[pdf.id] ?? {}
              const hasPdfResults = Object.keys(pdfResults).length > 0
              let trustValid = 0, trustKunye = 0, trustUydurma = 0
              for (const r of Object.values(pdfResults)) {
                if (r.status === 'in_progress' || r.status === 'pending') continue
                const tt = effectiveTrustTag(r)
                if (tt === 'clean') trustValid++
                else if (tt === 'künye') trustKunye++
                else if (tt === 'uydurma') trustUydurma++
              }
              // While re-verifying a PDF that already had a complete run,
              // hold the pills at the prior snapshot so they don't drop to
              // zero and climb back up during the new run.
              const frozen = pdfVerifying ? frozenPdfCountsRef.current[pdf.id] : undefined
              const dispFound = frozen ? frozen.found : summary?.found ?? 0
              const dispProblematic = frozen ? frozen.problematic : summary?.problematic ?? 0
              const dispNotFound = frozen ? frozen.not_found : summary?.not_found ?? 0
              const dispTrustValid = frozen ? frozen.trustValid : trustValid
              const dispTrustKunye = frozen ? frozen.trustKunye : trustKunye
              const dispTrustUydurma = frozen ? frozen.trustUydurma : trustUydurma
              nodes.push(
                <div
                  key={pdf.id}
                  ref={setPdfItemRef(pdf.id)}
                  className={`${styles['verify-item']} ${effectivePdfId === pdf.id ? styles['verify-selected'] : ''}`}
                  onClick={() => selectPdf(pdf.id)}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    if (!pdfVerifying) return
                    const order =
                      useVerificationStore.getState().sourceOrder[pdf.id]
                      ?? useSourcesStore.getState().sourcesByPdf[pdf.id]?.map(s => s.id)
                      ?? Object.keys(pdfResults)
                    const firstInProgress = order.find(id => pdfResults[id]?.status === 'in_progress')
                    if (!firstInProgress) return
                    if (effectivePdfId === pdf.id) {
                      selectSource(firstInProgress)
                      scrollCardIntoView(firstInProgress, 'smooth')
                    } else {
                      pendingJumpRef.current = { pdfId: pdf.id, sourceId: firstInProgress }
                      selectPdf(pdf.id)
                    }
                  }}
                >
                  <div className={styles['verify-item-top']}>
                    {pdfVerifying ? (
                      <span className={`${styles['vi-status']} ${styles['vi-spin']}`}>&#x25CC;</span>
                    ) : hasPdfResults ? (
                      <span className={styles['vi-status']} style={{ color: STATUS_HEX.found }}>&#x2713;</span>
                    ) : (
                      <span className={styles['vi-status']} style={{ color: STATUS_HEX.neutral }}>&#x25CB;</span>
                    )}
                    <span className={styles['vi-name']}>{pdf.name}</span>
                    <button
                      className={styles['vi-verify-btn']}
                      onClick={(e) => { e.stopPropagation(); handleVerifyOrCancelPdf(pdf.id) }}
                      title={isPdfVerifying(pdf.id) ? t('verification.stopVerification') : t('verification.verifyThisPdf')}
                    >{isPdfVerifying(pdf.id) ? '\u25A0' : '\u25B6'}</button>
                  </div>
                  {(summary || frozen) && (
                    <div className={styles['verify-counts']}>
                      <span className={`${styles['vc']} ${styles['vc-found']}`}>{dispFound}</span>
                      <span className={`${styles['vc']} ${styles['vc-problematic']}`}>{dispProblematic}</span>
                      <span className={`${styles['vc']} ${styles['vc-not-found']}`}>{dispNotFound}</span>
                      {(hasPdfResults || frozen) && (
                        <>
                          <span className={styles['vc-divider']} aria-hidden="true" />
                          <span className={`${styles['vc']} ${styles['vc-valid']}`}>{dispTrustValid}</span>
                          <span className={`${styles['vc']} ${styles['vc-kunye']}`}>{dispTrustKunye}</span>
                          <span className={`${styles['vc']} ${styles['vc-uydurma']}`}>{dispTrustUydurma}</span>
                        </>
                      )}
                    </div>
                  )}
                </div>
              )
            })
            if (effectiveCutoff >= sortedPdfs.length) nodes.push(renderDivider())
            return nodes
          })()}
        </div>
      </aside>

      {/* Center Panel: Source Card List */}
      <section className={styles['verify-center']} ref={verifyCenterRef}>
        {!effectivePdfId ? (
          <div className={styles['center-empty']}>
            <div className={styles['center-empty-icon']}>&#x25C9;</div>
            <p>{t('verification.selectPdf')}</p>
          </div>
        ) : orderedSources.length === 0 ? (
          <div className={styles['center-empty']}>
            <p>{t('verification.noSources')}</p>
          </div>
        ) : (
          <>
            {/* Toolbar */}
            <div className={styles['card-toolbar']}>
              <div className={styles['toolbar-left']}>
                <button
                  className={`${styles['toolbar-btn']} ${styles['toolbar-btn-enable-all']}`}
                  onClick={() => effectivePdfId && setAllEnabled(effectivePdfId, !areAllSourcesEnabled)}
                  title={areAllSourcesEnabled ? t('verification.disableAll') : t('verification.enableAll')}
                  aria-label={areAllSourcesEnabled ? t('verification.disableAll') : t('verification.enableAll')}
                >
                  {enabledCount} / {orderedSources.length}
                </button>
                <button
                  className={`${styles['toolbar-btn']} ${styles['toolbar-btn-accent']}`}
                  onClick={() => effectivePdfId && handleVerifyNonFoundPdf(effectivePdfId)}
                  disabled={!effectivePdfId || (effectivePdfId ? isPdfVerifying(effectivePdfId) : true)}
                  title={t('verification.verifyNonFound')}
                ><span aria-hidden="true">&#x25B6;</span>{t('verification.nfShort')}</button>
              </div>
              <div className={styles['toolbar-center']}>
                <input
                  type="text"
                  className={styles['toolbar-search']}
                  value={cardSearchQuery}
                  onChange={(e) => setCardSearchQuery(e.target.value)}
                  placeholder={effectivePdfId ? t('verification.searchPlaceholderPdf', { name: (pdfs.find(p => p.id === effectivePdfId)?.name ?? '').replace(/\.[^.]+$/, '') }) : t('verification.searchPlaceholder')}
                  aria-label={effectivePdfId ? t('verification.searchPlaceholderPdf', { name: (pdfs.find(p => p.id === effectivePdfId)?.name ?? '').replace(/\.[^.]+$/, '') }) : t('verification.searchPlaceholder')}
                />
              </div>
              <div className={styles['toolbar-right']}>
                <div
                  className={`${styles['sort-dropdown']} ${sortOpen ? styles['sort-dropdown-open'] : ''}`}
                  ref={sortDropdownRef}
                >
                  <button
                    type="button"
                    className={`${styles['toolbar-btn']} ${styles['sort-active']}`}
                    title={t('verification.sort.label')}
                    aria-haspopup="menu"
                    aria-expanded={sortOpen}
                    onClick={() => setSortOpen(o => !o)}
                  >
                    {t(`verification.sort.${cardSortKey}`)}
                    <span className={styles['sort-arrow']}>{cardSortAsc ? '\u2191' : '\u2193'}</span>
                    <span className={styles['sort-caret']} aria-hidden="true">{'\u25be'}</span>
                  </button>
                  {sortOpen && (
                    <ul className={styles['sort-menu']} role="menu">
                      {(['ref', 'enabled', 'status', 'trust'] as const).map(key => (
                        <li key={key} role="none">
                          <button
                            type="button"
                            role="menuitem"
                            className={cardSortKey === key ? styles['sort-active'] : ''}
                            onClick={() => { toggleCardSort(key); setSortOpen(false) }}
                          >
                            <span>{t(`verification.sort.${key}`)}</span>
                            {cardSortKey === key && (
                              <span className={styles['sort-arrow']}>{cardSortAsc ? '\u2191' : '\u2193'}</span>
                            )}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <button
                  className={`${styles['toolbar-btn']} ${styles['toolbar-btn-export']}`}
                  onClick={handleExportVerificationReport}
                  disabled={!effectivePdfId || !currentSummary || exportingReport}
                  title={t('verification.exportPdf')}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
                    <polyline points="7 10 12 15 17 10"/>
                    <line x1="12" y1="15" x2="12" y2="3"/>
                  </svg>
                </button>
              </div>
            </div>

            {/* Source cards */}
            <div className={styles['card-list']} ref={cardListRef} data-scrollable>
              {filteredSourceCards.map((card, idx) => {
                const isSelected = selectedSourceId === card.source.id
                const cardClass = [
                  styles['source-card'],
                  isSelected ? styles['card-selected'] : '',
                  !card.enabled ? styles['card-disabled'] : '',
                  dropTargetIdx === idx && dragSourceId !== card.source.id ? styles['card-dragover'] : '',
                ].filter(Boolean).join(' ')

                // Tint the selected-border per trust state (Geçerli/Künye/Uydurma).
                const trust = card.result ? effectiveTrustTag(card.result) : null
                const trustBorderColor =
                  trust === 'clean' ? TRUST_HEX.validBorder
                  : trust === 'künye' ? TRUST_HEX.kunyeBorder
                  : trust === 'uydurma' ? TRUST_HEX.uydurmaBorder
                  : undefined
                const trustGlow =
                  trust === 'clean' ? 'rgba(134, 239, 172, 0.35)'
                  : trust === 'künye' ? 'rgba(148, 163, 184, 0.35)'
                  : trust === 'uydurma' ? 'rgba(232, 121, 249, 0.35)'
                  : undefined

                return (
                  <div
                    key={card.source.id}
                    ref={(el) => { cardRefs.current[card.source.id] = el }}
                    className={cardClass}
                    style={trustBorderColor ? {
                      ['--card-trust-border' as string]: trustBorderColor,
                      ['--card-trust-glow' as string]: trustGlow,
                    } as React.CSSProperties : undefined}
                    role="button"
                    tabIndex={0}
                    aria-pressed={isSelected}
                    onClick={() => selectSource(isSelected ? null : card.source.id)}
                    onKeyDown={(e) => {
                      if (e.currentTarget !== e.target) return
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        selectSource(isSelected ? null : card.source.id)
                      }
                    }}
                    onDragOver={(e) => onDragOver(e, idx)}
                    onDrop={(e) => onDrop(e, idx)}
                  >
                    {/* Status bar */}
                    <div className={styles['status-bar']} style={{ background: statusColor(card.result) }} />

                    <div className={styles['card-body']}>
                      {/* Header row */}
                      <div className={styles['card-header']}>
                        <button
                          type="button"
                          className={`${styles['ref-badge']} ${card.enabled ? '' : styles['ref-badge-disabled']}`}
                          aria-pressed={card.enabled}
                          title={card.enabled ? t('verification.disableRef') : t('verification.enableRef')}
                          onClick={(e) => { e.stopPropagation(); selectSource(card.source.id); toggleSourceEnabled(card.source.id) }}
                        >
                          [{card.source.ref_number ?? '?'}]
                        </button>
                        {card.result?.status === 'in_progress' && (
                          <span className={styles['status-badge']} style={{ background: STATUS_HEX.in_progress, color: 'white' }}>
                            {i18n.t('verification.status.in_progress')}
                          </span>
                        )}
                        <span className={styles['card-actions']}>
                          <button
                            className={styles['copy-btn']}
                            onClick={(e) => {
                              e.stopPropagation()
                              selectSource(card.source.id)
                              const text = verifyTexts[card.source.id] ?? sanitizeReferenceText(card.source.text)
                              navigator.clipboard.writeText(text)
                            }}
                            title={t('verification.copyText')}
                          >
                            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                              <rect x="5.5" y="5.5" width="9" height="9" rx="1.5" />
                              <path d="M10.5 5.5V3a1.5 1.5 0 00-1.5-1.5H3A1.5 1.5 0 001.5 3v6A1.5 1.5 0 003 10.5h2.5" />
                            </svg>
                          </button>
                          {verifyTexts[card.source.id] != null && sourceOriginalTexts[card.source.id] != null && verifyTexts[card.source.id] !== sourceOriginalTexts[card.source.id] && (
                            <button
                              className={styles['reset-btn']}
                              onClick={(e) => {
                                e.stopPropagation()
                                selectSource(card.source.id)
                                resetVerifyText(card.source.id)
                              }}
                              title={t('verification.resetToOriginal')}
                            >&#x21BA;</button>
                          )}
                        </span>
                        <span className={styles['card-status-group']}>
                          {card.result && (
                            <span className={styles['problem-tags']}>
                              {TAG_ORDER.map((tag: TagKey) => {
                                const on = effectiveTagOn(card.result, tag)
                                const isTitle = tag === 'title'
                                const baseClass = isTitle ? styles['title-tag'] : styles['problem-tag']
                                const offClass = isTitle ? styles['title-tag-off'] : styles['problem-tag-off']
                                const className = on ? baseClass : offClass
                                const onToggle = (e: React.MouseEvent) => {
                                  e.stopPropagation()
                                  selectSource(card.source.id)
                                  if (!effectivePdfId || !card.result) return
                                  pendingScrollCardIdRef.current = card.source.id
                                  useVerificationStore.getState().toggleTag(effectivePdfId, card.source.id, tag)
                                }
                                if (isTitle) {
                                  const bm = card.result?.best_match
                                  const pct = bm ? Math.round(bm.match_details.title_similarity * 100) : null
                                  const label = pct != null
                                    ? `${t('verification.titleShort')}: ${pct}%`
                                    : `${t('verification.titleShort')}: —`
                                  const tip = on ? (pct != null ? t('verification.titleSimilarity', { percent: pct }) : t('verification.titleShort')) : undefined
                                  return (
                                    <button key={tag} type="button" className={className} onClick={onToggle} title={tip}>
                                      {label}
                                    </button>
                                  )
                                }
                                const bangKey = `!${tag}`
                                const tip = on ? problemTagDescription(bangKey) : undefined
                                return (
                                  <button key={tag} type="button" className={className} onClick={onToggle} title={tip}>
                                    {problemTagLabel(bangKey)}
                                  </button>
                                )
                              })}
                            </span>
                          )}
                          {card.result && (() => {
                            const trust = effectiveTrustTag(card.result)
                            const cls = trust === 'clean'
                              ? styles['valid-tag']
                              : trust === 'künye'
                                ? styles['citation-tag']
                                : styles['uydurma-tag']
                            const label = trust === 'clean'
                              ? t('verification.validTag')
                              : trust === 'künye'
                                ? t('verification.citationTag')
                                : t('verification.uydurmaTag')
                            const tip = trust === 'clean'
                              ? t('verification.validTagTooltip')
                              : trust === 'künye'
                                ? t('verification.citationTagTooltip')
                                : t('verification.uydurmaTagTooltip')
                            return (
                              <button
                                type="button"
                                className={cls}
                                title={tip}
                                onClick={(e) => {
                                  e.stopPropagation()
                                  selectSource(card.source.id)
                                  if (!effectivePdfId) return
                                  pendingScrollCardIdRef.current = card.source.id
                                  useVerificationStore.getState().cycleTrustTag(effectivePdfId, card.source.id)
                                }}
                              >
                                {label}
                              </button>
                            )
                          })()}
                        </span>
                      </div>

                      {/* Textarea row — drag handle on the left, vertically centered */}
                      <div className={styles['card-body-row']}>
                        <span
                          className={styles['drag-handle']}
                          draggable
                          onDragStart={(e) => { e.stopPropagation(); onDragStart(e, card.source.id) }}
                          onDragEnd={onDragEnd}
                          onPointerDown={(e) => e.stopPropagation()}
                          title={t('verification.dragToReorder')}
                          aria-hidden="true"
                        >&#x2807;</span>
                        <textarea
                          className={styles['card-textarea']}
                          value={verifyTexts[card.source.id] ?? sanitizeReferenceText(card.source.text)}
                          onInput={(e) => {
                            const el = e.target as HTMLTextAreaElement
                            setVerifyText(card.source.id, el.value)
                            autoResize(el)
                          }}
                          onFocus={(e) => { selectSource(card.source.id); autoResize(e.target as HTMLTextAreaElement) }}
                          onClick={(e) => { e.stopPropagation(); selectSource(card.source.id) }}
                          rows={2}
                          disabled={!card.enabled}
                        />
                      </div>

                      {/* Progress indicator */}
                      {card.progress && (card.result?.status === 'in_progress' || card.progress.checkedDbs.length > 0) && (
                        <div className={styles['card-progress']}>
                          {card.result?.status === 'in_progress' && (
                            <span className={styles['progress-spinner']}>&#x25CC;</span>
                          )}
                          <span className={styles['progress-text']}>
                            {card.progress.currentDb
                              ? `Searching ${card.progress.currentDb}...`
                              : card.result?.status === 'in_progress'
                                ? 'Waiting...'
                                : `${card.progress.checkedDbs.length} searched`}
                          </span>
                          <div className={styles['progress-dots']}>
                            {enabledDatabases.map(db => {
                              const check = card.progress?.checkedDbs.find((d: DbCheckEntry) => d.name === db)
                              const isCurrent = card.progress?.currentDb === db
                              const dotClass = [
                                styles['progress-dot'],
                                check ? styles[`dot-${check.status}`] : '',
                                isCurrent ? styles['dot-current'] : '',
                              ].filter(Boolean).join(' ')
                              return (
                                <span
                                  key={db}
                                  className={dotClass}
                                  title={`${db}${check ? `: ${check.status}` : ''}`}
                                />
                              )
                            })}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>

            {/* Scholar scan progress bar */}
            {(scholarStatus === 'scanning' || scholarStatus === 'captcha') && (
              <div className={styles['scholar-scan-bar']}>
                <span className={styles['scholar-scan-info']}>
                  {t('verification.scholarScanLabel')}
                  {scholarTotal === 0 ? (
                    <> &middot; {t('verification.scholarPreparing')}</>
                  ) : (
                    <>
                      {scholarBannerInfo.pdfName && <> | {scholarBannerInfo.pdfName}</>}
                      {' '}&middot; {scholarCurrentIndex}/{scholarTotal} {t('verification.scholarVerified')}
                      {scholarBannerInfo.lastRefNumber != null && scholarBannerInfo.lastUpdated != null ? (
                        <> : [{scholarBannerInfo.lastRefNumber}] {scholarBannerInfo.lastUpdated ? t('verification.scholarGotResults') : t('verification.scholarNoResults')}</>
                      ) : scholarBannerInfo.refNumber != null ? (
                        <> : [{scholarBannerInfo.refNumber}]</>
                      ) : null}
                    </>
                  )}
                </span>
                {scholarStatus === 'captcha' && (
                  <button className={styles['action-btn']} onClick={handleResumeClick}>
                    {t('verification.scholarResume')}
                  </button>
                )}
                <button className={styles['action-btn']} onClick={() => useScholarScanStore.getState().cancelScan()}>
                  {t('verification.scholarCancel')}
                </button>
              </div>
            )}

            {browserOverlayOpen && (
              <div className={styles['scholar-overlay']} style={{ height: `${browserOverlayHeight}px` }} ref={browserOverlayRef}>
                {scholarStatus === 'captcha' && (
                  <div className={styles['scholar-captcha-banner']}>
                    {t('verification.scholarCaptchaBanner')}
                  </div>
                )}
                <div className={styles['scholar-overlay-resizer']} onMouseDown={startOverlayResize} title={t('verification.browser.dragToResize')}>
                  <span className={styles['scholar-overlay-resizer-line']} />
                </div>
                <div className={styles['scholar-overlay-header']}>
                  <div className={styles['scholar-overlay-nav-actions']}>
                    <button
                      className={`${styles['action-btn']} ${styles['overlay-icon-btn']}`}
                      onClick={goBrowserBack}
                      disabled={!browserCanGoBack}
                      title={t('verification.browser.back')}
                      aria-label={t('verification.browser.back')}
                    >
                      <svg className={styles['overlay-icon']} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M10.5 3.5L5.5 8l5 4.5" />
                      </svg>
                    </button>
                    <button
                      className={`${styles['action-btn']} ${styles['overlay-icon-btn']}`}
                      onClick={goBrowserForward}
                      disabled={!browserCanGoForward}
                      title={t('verification.browser.forward')}
                      aria-label={t('verification.browser.forward')}
                    >
                      <svg className={styles['overlay-icon']} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M5.5 3.5L10.5 8l-5 4.5" />
                      </svg>
                    </button>
                    <button
                      className={`${styles['action-btn']} ${styles['overlay-icon-btn']}`}
                      onClick={reloadBrowserView}
                      title={t('verification.browser.reload')}
                      aria-label={t('verification.browser.reload')}
                    >
                      <svg className={styles['overlay-icon']} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M13 4.5v3h-3" />
                        <path d="M12.4 7.5A5 5 0 103.8 11" />
                      </svg>
                    </button>
                  </div>
                  <div className={styles['scholar-overlay-zoom-actions']}>
                    {isOverlayCollapsed ? (
                      <button
                        className={`${styles['action-btn']} ${styles['overlay-icon-btn']}`}
                        onClick={maximizeOverlay}
                        title={t('verification.browser.maximize')}
                        aria-label={t('verification.browser.maximize')}
                      >
                        <svg className={styles['overlay-icon']} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <polyline points="4,8.5 8,4.5 12,8.5" />
                          <polyline points="4,12 8,8 12,12" />
                        </svg>
                      </button>
                    ) : Math.abs(browserZoomFactor - 1) > 0.01 ? (
                      <>
                        <button
                          className={`${styles['action-btn']} ${styles['overlay-zoom-btn']}`}
                          onClick={zoomBrowserOut}
                          title={t('verification.browser.zoomOut')}
                          aria-label={t('verification.browser.zoomOut')}
                        >-</button>
                        <button
                          className={`${styles['action-btn']} ${styles['overlay-zoom-readout']}`}
                          onClick={resetBrowserZoom}
                          title={t('verification.browser.resetZoom')}
                          aria-label={t('verification.browser.resetZoom')}
                        >{Math.round(browserZoomFactor * 100)}%</button>
                        <button
                          className={`${styles['action-btn']} ${styles['overlay-zoom-btn']}`}
                          onClick={zoomBrowserIn}
                          title={t('verification.browser.zoomIn')}
                          aria-label={t('verification.browser.zoomIn')}
                        >+</button>
                      </>
                    ) : (
                      <input
                        type="text"
                        className={styles['scholar-overlay-url-bar']}
                        value={browserCurrentUrl || browserOverlayUrl}
                        readOnly
                        spellCheck={false}
                        onFocus={(e) => e.currentTarget.select()}
                        onMouseUp={(e) => e.stopPropagation()}
                        title={browserCurrentUrl || browserOverlayUrl}
                        aria-label={t('verification.browser.urlBar')}
                      />
                    )}
                  </div>
                  <div className={styles['scholar-overlay-actions']}>
                    <button
                      className={`${styles['action-btn']} ${styles['overlay-icon-btn']} ${findBarOpen ? styles['overlay-icon-btn-active'] : ''}`}
                      onClick={() => findBarOpen ? closeFindBar() : openFindBar()}
                      title={t('verification.browser.find')}
                      aria-label={t('verification.browser.find')}
                      aria-pressed={findBarOpen}
                    >
                      <svg className={styles['overlay-icon']} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <circle cx="7" cy="7" r="3.5" />
                        <path d="M9.6 9.6L13 13" />
                      </svg>
                    </button>
                    <button
                      className={`${styles['action-btn']} ${styles['overlay-icon-btn']}`}
                      onClick={() => openExternal(browserOverlayUrl)}
                      title={t('verification.browser.openExternal')}
                      aria-label={t('verification.browser.openExternal')}
                    >
                      <svg className={styles['overlay-icon']} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M9 3.5h3.5V7" />
                        <path d="M12.5 3.5L7 9" />
                        <path d="M12 8.8V12a1 1 0 01-1 1H4a1 1 0 01-1-1V5a1 1 0 011-1h3.2" />
                      </svg>
                    </button>
                    <button
                      className={`${styles['action-btn']} ${styles['overlay-icon-btn']}`}
                      onClick={closeBrowserOverlay}
                      title={t('verification.browser.close')}
                      aria-label={t('verification.browser.close')}
                    >
                      <svg className={styles['overlay-icon']} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M4.5 4.5l7 7" />
                        <path d="M11.5 4.5l-7 7" />
                      </svg>
                    </button>
                  </div>
                </div>
                <div className={styles['scholar-overlay-webview-wrap']}>
                  <webview
                    ref={browserWebviewRef}
                    className={styles['scholar-overlay-webview']}
                    src={browserOverlayUrl}
                    partition="persist:scholar-panel"
                    useragent={scholarPanelUserAgent}
                    {...({ allowpopups: 'true' } as Record<string, string>)}
                  />
                  {/* Transparent shield covers the webview during resize so mouseup reaches
                      the host window — the webview's guest process otherwise swallows it
                      and leaves the drag stuck on. */}
                  {overlayResizing && (
                    <div
                      className={styles['webview-drag-shield']}
                      onMouseUp={() => {
                        setOverlayResizing(false)
                        overlayResizeStartRef.current = null
                      }}
                    />
                  )}
                  {findBarOpen && (
                    <div className={styles['find-bar']} role="search">
                      <input
                        ref={findInputRef}
                        className={styles['find-input']}
                        type="text"
                        value={findQuery}
                        onChange={(e) => {
                          const next = e.target.value
                          setFindQuery(next)
                          runFindInPage(next, { findNext: false })
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault()
                            navigateFind(!e.shiftKey)
                          } else if (e.key === 'Escape') {
                            e.preventDefault()
                            closeFindBar()
                          }
                        }}
                        placeholder={t('verification.browser.findPlaceholder')}
                        aria-label={t('verification.browser.findPlaceholder')}
                        spellCheck={false}
                        autoComplete="off"
                      />
                      <span className={`${styles['find-count']} ${findQuery && findTotal === 0 ? styles['find-count-empty'] : ''}`}>
                        {findQuery ? `${findActive}/${findTotal}` : '0/0'}
                      </span>
                      <button
                        type="button"
                        className={`${styles['action-btn']} ${styles['find-btn']}`}
                        onClick={() => navigateFind(false)}
                        disabled={!findQuery || findTotal === 0}
                        title={t('verification.browser.findPrev')}
                        aria-label={t('verification.browser.findPrev')}
                      >
                        <svg className={styles['overlay-icon']} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="M2.5 11l5.5-5.5 5.5 5.5" />
                        </svg>
                      </button>
                      <button
                        type="button"
                        className={`${styles['action-btn']} ${styles['find-btn']}`}
                        onClick={() => navigateFind(true)}
                        disabled={!findQuery || findTotal === 0}
                        title={t('verification.browser.findNext')}
                        aria-label={t('verification.browser.findNext')}
                      >
                        <svg className={styles['overlay-icon']} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="M2.5 5l5.5 5.5 5.5-5.5" />
                        </svg>
                      </button>
                      <button
                        type="button"
                        className={`${styles['action-btn']} ${styles['find-btn']}`}
                        onClick={closeFindBar}
                        title={t('verification.browser.findClose')}
                        aria-label={t('verification.browser.findClose')}
                      >
                        <svg className={styles['overlay-icon']} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="M3 3l10 10" />
                          <path d="M13 3l-10 10" />
                        </svg>
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Hidden webview for Scholar scanner */}
            <webview
              ref={scholarScanWebviewRef}
              src="about:blank"
              partition="persist:scholar-panel"
              useragent={scholarPanelUserAgent}
              style={{ position: 'fixed', left: '-9999px', top: '0', width: '1280px', height: '800px', opacity: 0, pointerEvents: 'none' } as React.CSSProperties}
            />
          </>
        )}
      </section>

      {/* Right Panel: Source Detail */}
      <aside className={styles['verify-right']} onMouseDownCapture={() => browserOverlayOpen && closeBrowserOverlay()}>
        {selectedSourceId && (
          <div className={styles['detail-top-row']}>
            <button
              className={styles['detail-ref-badge']}
              onClick={() => {
                const el = cardRefs.current[selectedSourceId]
                if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
              }}
              title={t('verification.scrollToCard')}
            >[{currentSource?.ref_number ?? '?'}]</button>
            <div className={styles['detail-actions']}>
              <button
                className={`${styles['action-btn']} ${styles['action-btn-accent']}`}
                onClick={handleReverifyOrCancelSource}
                title={currentResult?.status === 'in_progress' ? t('verification.stopVerification') : t('verification.verifyThisSource')}
              >
                {currentResult?.status === 'in_progress'
                  ? <><span>&#x25A0;</span> {t('verification.stop')}</>
                  : <><span>&#x21BB;</span> {t('verification.verify')}</>}
              </button>
            </div>
          </div>
        )}
        <div className={styles['detail-body']}>
          {selectedSourceId ? (() => {
            const r = currentResult
            const hasCompletedResult = Boolean(r && r.status !== 'in_progress')
            return (
              <>
                <div className={styles['detail-action-row']}>
                  {currentResult && (() => {
                    const trust = effectiveTrustTag(currentResult)
                    const cls = trust === 'clean'
                      ? styles['valid-tag']
                      : trust === 'künye'
                        ? styles['citation-tag']
                        : styles['uydurma-tag']
                    const label = trust === 'clean'
                      ? t('verification.validTag')
                      : trust === 'künye'
                        ? t('verification.citationTag')
                        : t('verification.uydurmaTag')
                    const tip = trust === 'clean'
                      ? t('verification.validTagTooltip')
                      : trust === 'künye'
                        ? t('verification.citationTagTooltip')
                        : t('verification.uydurmaTagTooltip')
                    return (
                      <button
                        type="button"
                        className={`${cls} ${styles['detail-trust-pill']}`}
                        title={tip}
                        onClick={() => {
                          if (!effectivePdfId || !selectedSourceId) return
                          useVerificationStore.getState().cycleTrustTag(effectivePdfId, selectedSourceId)
                        }}
                      >{label}</button>
                    )
                  })()}
                  <div className={styles['detail-action-spacer']} />
                  <button
                    className={`${styles['override-btn']} ${styles['override-found']} ${currentResult?.status === 'found' ? styles['override-found-active'] : ''}`}
                    disabled={!currentResult || currentResult.status === 'in_progress'}
                    onClick={() => handleOverride('found')} title={t('verification.markAsFound')}
                  >&#x2713;</button>
                  <button
                    className={`${styles['override-btn']} ${styles['override-problematic']} ${currentResult?.status === 'problematic' ? styles['override-problematic-active'] : ''}`}
                    disabled={!currentResult || currentResult.status === 'in_progress'}
                    onClick={() => handleOverride('problematic')} title={t('verification.markAsProblematic')}
                  >~</button>
                  <button
                    className={`${styles['override-btn']} ${styles['override-not-found']} ${currentResult?.status === 'not_found' ? styles['override-not-found-active'] : ''}`}
                    disabled={!currentResult || currentResult.status === 'in_progress'}
                    onClick={() => handleOverride('not_found')} title={t('verification.markAsNotFound')}
                  >X</button>
                </div>

                <div className={styles['detail-search-actions']}>
                  <button
                    className={`${styles['action-btn']} ${styles['detail-search-btn']}`}
                    onClick={openScholarOverlay}
                    disabled={!selectedTitleOrText}
                    title={t('verification.openGoogleScholar')}
                  >{t('verification.googleScholar')}</button>
                  <button
                    className={`${styles['action-btn']} ${styles['detail-search-btn']}`}
                    onClick={openGoogleOverlay}
                    disabled={!selectedTitleOrText}
                    title={t('verification.openGoogleSearch')}
                  >{t('verification.googleSearch')}</button>
                </div>
                <div className={styles['section-title']}>{t('verification.bestMatch')}</div>

                {hasCompletedResult && r && (
                  <>
                    {r.best_match ? (
                      <div className={styles['match-card']}>
                        <div className={styles['match-title']}>{r.best_match.title}</div>
                        {r.best_match.authors.length > 0 && (
                          <div className={styles['match-meta']}>{r.best_match.authors.join(', ')}</div>
                        )}
                        {r.best_match.journal && (
                          <div className={styles['match-source']}>{r.best_match.journal}</div>
                        )}
                        <div className={styles['match-meta-row']}>
                          {r.best_match.year && <span>{r.best_match.year}</span>}
                          {r.best_match.doi && <span className={styles['match-doi']}>DOI: {r.best_match.doi}</span>}
                        </div>
                        <div className={styles['match-meta-row']}>
                          <span className={styles['match-db']}>{r.best_match.database}</span>
                          <span className={styles['match-score']} style={{ color: dbScoreColor(r.best_match.score) }}>
                            {Math.round(r.best_match.score * 100)}%
                          </span>
                        </div>
                        {r.best_match.url && (
                          <button className={styles['match-link']} onClick={() => openOverlayWithUrl(r.best_match!.url)}>{t('verification.openSource')} &#x2197;</button>
                        )}
                      </div>
                    ) : (
                      <div className={styles['match-empty']}>{t('verification.noMatchFound')}</div>
                    )}

                    {/* All database results */}
                    <div className={styles['section-title']}>{t('verification.databaseResults')}</div>
                    <div className={styles['detail-db-list']}>
                      {[...enabledDatabases, ...(r.databases_searched.includes('Google Scholar') ? ['Google Scholar'] : [])].map(db => {
                        const match = r.all_results.find((m: MatchResult) => m.database === db)
                        const searched = r.databases_searched.includes(db)
                        const dbCheck = selectedProgress?.checkedDbs.find(d => d.name === db)
                        const searchText = selectedParsedTitle || verifyTexts[selectedSourceId] || currentSource?.text || ''
                        // Prefer backend-provided URLs (built with NER title) over local computation
                        const linkUrl = match?.search_url || dbCheck?.searchUrl || buildDbSearchUrl(db, searchText)
                        return (
                          <div key={db} className={styles['db-row']}>
                            <span className={`${styles['db-icon']} ${match && dbScoreIcon(match.score) === '~' ? styles['db-icon-mediocre'] : ''} ${!match && searched ? styles['db-icon-empty'] : ''}`} style={{ color: match ? dbScoreColor(match.score) : searched ? STATUS_HEX.neutral : '#d6d3d1' }}>
                              {match ? dbScoreIcon(match.score) : searched ? '\u2013' : '\u25CB'}
                            </span>
                            {linkUrl ? (
                              <button className={`${styles['db-name']} ${styles['db-link']} ${!searched && !match ? styles['db-link-unsearched'] : ''}`} onClick={() => openOverlayWithUrl(linkUrl)}>{db}</button>
                            ) : (
                              <span className={styles['db-name']}>{db}</span>
                            )}
                            {match ? (
                              <span className={styles['db-score']} style={{ color: dbScoreColor(match.score) }}>{Math.round(match.score * 100)}%</span>
                            ) : !searched ? (
                              <span className={`${styles['db-score']} ${styles['db-pending']}`}>--</span>
                            ) : null}
                          </div>
                        )
                      })}
                    </div>

                    {r.url_liveness && Object.keys(r.url_liveness).length > 0 && (
                      <div className={styles['detail-urls']}>
                        <div className={styles['section-title']}>{t('verification.urlStatus')}</div>
                        <ul className={styles['url-list']}>
                          {Object.entries(r.url_liveness).map(([url, alive]) => (
                            <li key={url} className={styles['url-item']}>
                              <span
                                className={styles['url-dot']}
                                style={{ background: alive ? STATUS_HEX.found : STATUS_HEX.not_found }}
                                title={alive ? t('verification.urlReachable') : t('verification.urlDead')}
                              />
                              <button className={styles['url-link']} onClick={() => openOverlayWithUrl(url)} title={url}>
                                {url.length > 50 ? url.slice(0, 50) + '\u2026' : url}
                              </button>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </>
                )}
              </>
            )
          })() : (
            <div className={styles['detail-empty']}>
              <p>{t('verification.selectSource')}</p>
            </div>
          )}
        </div>
      </aside>
    </div>
  )
}
