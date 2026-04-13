import { useState, useMemo, useEffect, useRef, useCallback } from 'react'
import { usePdfStore } from '../../stores/pdf-store'
import { useSourcesStore, loadSources as loadSourcesFn } from '../../stores/sources-store'
import { useVerificationStore } from '../../stores/verification-store'
import { useSettingsStore } from '../../stores/settings-store'
import { useScholarScanStore } from '../../stores/scholar-scan-store'
import { scholarScanner } from '../../services/scholar-scanner'
import type { VerificationResult, MatchResult, DbCheckEntry } from '../../api/types'
import { sanitizeReferenceText, sanitizeReferenceTextForSearch } from '../../utils/reference-text'
import styles from './VerificationPage.module.css'

const ALL_DATABASES = [
  'Crossref', 'OpenAlex', 'arXiv', 'Semantic Scholar', 'Europe PMC',
  'TRDizin', 'PubMed', 'CORE', 'PLOS', 'Open Library',
]

function statusColor(result: VerificationResult | undefined): string {
  if (!result) return '#9ca3af'
  switch (result.status) {
    case 'found': return '#22c55e'
    case 'problematic': return '#f59e0b'
    case 'not_found': return '#9ca3af'
    case 'in_progress': return '#3b82f6'
    default: return '#a8a29e'
  }
}

function statusLabel(result: VerificationResult | undefined): string {
  if (!result) return 'Pending'
  switch (result.status) {
    case 'found': return 'Found'
    case 'problematic': return 'Problematic'
    case 'not_found': return 'Not Found'
    case 'in_progress': return 'Searching...'
    default: return 'Pending'
  }
}

function problemTagDescription(tag: string): string {
  switch (tag) {
    case '!authors': return 'Source authors not found in candidate authors'
    case '!doi/arXiv': return 'Source DOI/arXiv differs from candidate'
    case '!url': return 'Non-DOI/arXiv URL is not reachable'
    case '!year': return 'Year mismatch (>1 year difference)'
    case '!publication': return 'Publication / venue mismatch'
    default: return tag
  }
}

function dbScoreIcon(score: number): string {
  if (score >= 0.65) return '\u2713'
  if (score >= 0.5) return '~'
  return '\u2715'
}

function dbScoreColor(score: number): string {
  if (score >= 0.65) return '#22c55e'
  if (score >= 0.5) return '#eab308'
  return '#ef4444'
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
    'CORE': `https://core.ac.uk/search?q=${q}`,
    'PLOS': `https://journals.plos.org/plosone/search?q=${q}`,
    'Open Library': `https://openlibrary.org/search?q=${q}`,
  }
  return urls[db] ?? ''
}

const statusOrder: Record<string, number> = { found: 0, problematic: 1, not_found: 2, in_progress: 3, pending: 4 }
type CardSortMode = 'default' | 'status' | 'ref' | 'enabled'
const MIN_BROWSER_ZOOM = 0.5
const MAX_BROWSER_ZOOM = 3
const BROWSER_ZOOM_STEP = 1.1

export default function VerificationPage() {
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

  const configuredDatabases = useSettingsStore(s => s.settings.databases)
  const enabledDatabases = useMemo(() => {
    const known = new Set(ALL_DATABASES)
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
  const currentSummary = useMemo(() => (effectivePdfId ? summaries[effectivePdfId] : undefined), [summaries, effectivePdfId])
  const orderedSourceIds = useMemo(() => (effectivePdfId ? (sourceOrder[effectivePdfId] ?? []) : []), [sourceOrder, effectivePdfId])

  // Toast for verification completion – only for actual runs, not cached loads
  const [verifyToast, setVerifyToast] = useState<string | null>(null)
  const verifyToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // PDFs whose verification run we kicked off in this session and are still
  // waiting to see complete. Adding a pdfId here arms the completion handler.
  const pendingVerifyPdfIdsRef = useRef<Set<string>>(new Set())
  // PDFs started via single-PDF verify (not Verify All) — auto-run GS when done
  const autoGsPdfIdsRef = useRef<Set<string>>(new Set())

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

      const pdf = allPdfs.find(p => p.id === pdfId)
      const name = pdf?.name ?? 'PDF'
      if (verifyToastTimerRef.current) clearTimeout(verifyToastTimerRef.current)
      setVerifyToast(`Verification complete: ${name}`)
      verifyToastTimerRef.current = setTimeout(() => setVerifyToast(null), 3000)

      if (autoGsPdfIdsRef.current.has(pdfId)) {
        autoGsPdfIdsRef.current.delete(pdfId)
        const autoGs = useSettingsStore.getState().settings.auto_scholar_after_verify ?? true
        if (autoGs) {
          setTimeout(() => {
            useScholarScanStore.getState().startScanForPdf(pdfId)
          }, 500)
        }
      }
    }
  }, [summaries, allPdfs])

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

  const sortedPdfs = useMemo(() => {
    const list = [...pdfs]
    const dir = pdfSortAsc ? 1 : -1
    list.sort((a, b) => {
      const sa = summaries[a.id]
      const sb = summaries[b.id]
      if (pdfSortKey === 'name') return dir * a.name.localeCompare(b.name)
      if (pdfSortKey === 'status') {
        const ao = sa?.completed ? 0 : sa ? 1 : 2
        const bo = sb?.completed ? 0 : sb ? 1 : 2
        return dir * (ao - bo)
      }
      if (pdfSortKey === 'found') return dir * ((sa?.found ?? 0) - (sb?.found ?? 0))
      if (pdfSortKey === 'problematic') return dir * ((sa?.problematic ?? 0) - (sb?.problematic ?? 0))
      return dir * ((sa?.not_found ?? 0) - (sb?.not_found ?? 0))
    })
    return list
  }, [pdfs, pdfSortKey, pdfSortAsc, summaries])

  // --- Center panel sorting (persisted in store) ---
  const { toggleCardSort } = useVerificationStore.getState()

  const sortedSourceCards = useMemo(() => {
    if (cardSortKey === 'default') return sourceCards
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

  // Auto-load cached results for all approved PDFs on mount
  const hasAutoLoaded = useRef(false)
  useEffect(() => {
    if (hasAutoLoaded.current || pdfs.length === 0) return
    hasAutoLoaded.current = true
    const { loadResults } = useVerificationStore.getState()
    ;(async () => {
      for (const pdf of pdfs) {
        await loadResults(pdf.id)
      }
    })()
  }, [pdfs])

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

  // Actions
  async function handleStartOrCancel() {
    if (isAnyVerifying) {
      await useVerificationStore.getState().cancelAll()
    } else {
      const ids = pdfs.map(p => p.id)
      if (ids.length > 0) {
        for (const id of ids) pendingVerifyPdfIdsRef.current.add(id)
        await useVerificationStore.getState().startVerification(ids)
      }
    }
  }

  async function handleVerifyOrCancelPdf(pdfId: string) {
    if (isPdfVerifying(pdfId)) {
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
    await useVerificationStore.getState().startVerificationNonFoundForPdf(pdfId)
  }

  async function handleReverifyOrCancelSource() {
    if (!effectivePdfId || !selectedSourceId) return
    if (currentResult?.status === 'in_progress') {
      await useVerificationStore.getState().cancelSource(selectedSourceId)
    } else {
      const text = useVerificationStore.getState().verifyTexts[selectedSourceId]
      await useVerificationStore.getState().reverifySource(effectivePdfId, selectedSourceId, text)
    }
  }

  async function handleOverride(status: 'found' | 'problematic' | 'not_found') {
    if (!effectivePdfId || !selectedSourceId || !currentResult) return
    await useVerificationStore.getState().overrideStatus(effectivePdfId, selectedSourceId, status)
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
  const [browserZoomFactor, setBrowserZoomFactor] = useState(1)
  const browserZoomFactorRef = useRef(1)
  const preOverlaySortRef = useRef<{ key: CardSortMode; asc: boolean } | null>(null)

  // --- Scholar scan ---
  const scholarStatus = useScholarScanStore(s => s.status)
  const scholarCurrentIndex = useScholarScanStore(s => s.currentIndex)
  const scholarTotal = useScholarScanStore(s => s.totalInQueue)
  const scholarFoundCount = useScholarScanStore(s => s.foundCount)
  const scholarCaptchaUrl = useScholarScanStore(s => s.captchaUrl)

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

  // When CAPTCHA is detected, open the overlay with the CAPTCHA URL
  useEffect(() => {
    if (scholarStatus === 'captcha' && scholarCaptchaUrl) {
      openOverlayWithUrl(scholarCaptchaUrl)
    }
  }, [scholarStatus, scholarCaptchaUrl])

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
        const state = await view.executeJavaScript(`
          (function() {
            var hasCaptcha = !!document.querySelector('#gs_captcha_f, #gs_captcha_ccl, #captcha-form, #recaptcha')
              || !!document.querySelector('iframe[src*="recaptcha"]')
            var txt = (document.body && document.body.innerText) || ''
            if (txt.indexOf('unusual traffic') !== -1 || txt.indexOf('not a robot') !== -1) hasCaptcha = true
            var hasResults = !!document.querySelector('#gs_res_ccl, #gs_res_ccl_mid, .gs_r, .gs_ri')
            return { hasCaptcha: hasCaptcha, hasResults: hasResults, ready: document.readyState }
          })()
        `)
        if (!state || state.hasCaptcha || !state.hasResults) return
        if (state.ready !== 'complete' && state.ready !== 'interactive') return

        console.log('[Scholar] CAPTCHA solved detected, auto-resuming')
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

  function handleScholarScanPdf(pdfId?: string) {
    const id = pdfId ?? effectivePdfId
    if (!id) return
    useScholarScanStore.getState().startScanForPdf(id)
  }

  const selectedSearchText = useMemo(() => {
    if (!selectedSourceId) return ''
    const text = verifyTexts[selectedSourceId] ?? currentSource?.text ?? ''
    return sanitizeReferenceTextForSearch(text)
  }, [selectedSourceId, verifyTexts, currentSource])

  function getOverlayMaxHeight(): number {
    const minHeight = 220
    const defaultTopGap = 120
    const centerEl = verifyCenterRef.current
    const panelHeight = centerEl?.clientHeight ?? window.innerHeight

    if (!centerEl || !selectedSourceId) {
      return Math.max(minHeight, panelHeight - defaultTopGap)
    }

    const cardEl = cardRefs.current[selectedSourceId]
    if (!cardEl) {
      return Math.max(minHeight, panelHeight - defaultTopGap)
    }

    const panelRect = centerEl.getBoundingClientRect()
    const cardRect = cardEl.getBoundingClientRect()
    const topGap = Math.max(defaultTopGap, cardRect.bottom - panelRect.top + 8)
    return Math.max(minHeight, panelHeight - topGap)
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
      setBrowserOverlayHeight(getOverlayMaxHeight())
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
    const url = selectedSearchText
      ? `https://scholar.google.com/scholar?q=${encodeURIComponent(selectedSearchText)}`
      : 'https://scholar.google.com/'
    openOverlayWithUrl(url)
  }

  function openGoogleOverlay() {
    const url = selectedSearchText
      ? googleSearchUrl(selectedSearchText)
      : 'https://www.google.com/'
    openOverlayWithUrl(url)
  }

  function closeBrowserOverlay() {
    setBrowserOverlayOpen(false)
  }

  function syncBrowserNavState() {
    const view = browserWebviewRef.current
    if (!view) {
      setBrowserCanGoBack(false)
      setBrowserCanGoForward(false)
      return
    }
    try {
      setBrowserCanGoBack(Boolean(view.canGoBack?.()))
      setBrowserCanGoForward(Boolean(view.canGoForward?.()))
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
    const minHeight = 220
    const maxHeight = getOverlayMaxHeight()
    return Math.min(maxHeight, Math.max(minHeight, nextHeight))
  }

  function startOverlayResize(e: React.MouseEvent<HTMLDivElement>) {
    e.preventDefault()
    overlayResizeStartRef.current = { y: e.clientY, height: browserOverlayHeight }
    setOverlayResizing(true)
  }

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

    // Inject zoom handler into webview content so Ctrl+Wheel works inside the page
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
    }

    view.addEventListener('did-navigate', onViewStateChange)
    view.addEventListener('did-navigate-in-page', onViewStateChange)
    view.addEventListener('did-stop-loading', onDomReady)
    view.addEventListener('dom-ready', onDomReady)
    view.addEventListener('console-message', onConsoleMessage)

    const timer = window.setTimeout(onDomReady, 100)

    return () => {
      window.clearTimeout(timer)
      view.removeEventListener('did-navigate', onViewStateChange)
      view.removeEventListener('did-navigate-in-page', onViewStateChange)
      view.removeEventListener('did-stop-loading', onDomReady)
      view.removeEventListener('dom-ready', onDomReady)
      view.removeEventListener('console-message', onConsoleMessage)
    }
  }, [browserOverlayOpen, browserOverlayUrl, selectedSourceId, syncBrowserZoomState, zoomBrowserIn, zoomBrowserOut])

  useEffect(() => {
    if (!browserOverlayOpen) return

    const onKeyDown = (e: KeyboardEvent) => {
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

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [browserOverlayOpen, zoomBrowserIn, zoomBrowserOut, resetBrowserZoom])

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
      const delta = start.y - e.clientY
      setBrowserOverlayHeight(clampOverlayHeight(start.height + delta))
    }

    const onMouseUp = () => {
      setOverlayResizing(false)
      overlayResizeStartRef.current = null
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)

    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }, [overlayResizing])

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
          <h2 className={styles['panel-title']}>Verification</h2>
          <button className={styles['start-btn']} onClick={handleStartOrCancel} disabled={pdfs.length === 0}>
            {isAnyVerifying ? <><span>&#x25A0;</span> Stop</> : <><span>&#x25B6;</span> Verify All</>}
          </button>
        </div>

        {pdfs.length > 0 && (
          <div className={styles['verify-sort-bar']}>
            <button className={`${styles['sort-btn']} ${styles['sort-btn-status']} ${pdfSortKey === 'status' ? styles['sort-active'] : ''}`} onClick={() => togglePdfSort('status')} title="Sort by status">
              &#x25CF;{pdfSortKey === 'status' && <span className={styles['sort-arrow']}>{pdfSortAsc ? '\u2191' : '\u2193'}</span>}
            </button>
            <button className={`${styles['sort-btn']} ${styles['sort-btn-grow']} ${pdfSortKey === 'name' ? styles['sort-active'] : ''}`} onClick={() => togglePdfSort('name')} title="Sort by name">
              Name{pdfSortKey === 'name' && <span className={styles['sort-arrow']}>{pdfSortAsc ? '\u2191' : '\u2193'}</span>}
            </button>
            <button className={`${styles['sort-btn']} ${pdfSortKey === 'found' ? styles['sort-active'] : ''}`} onClick={() => togglePdfSort('found')} title="Sort by found count" style={{ color: pdfSortKey === 'found' ? '#22c55e' : undefined }}>
              &#x2713;{pdfSortKey === 'found' && <span className={styles['sort-arrow']}>{pdfSortAsc ? '\u2191' : '\u2193'}</span>}
            </button>
            <button className={`${styles['sort-btn']} ${pdfSortKey === 'problematic' ? styles['sort-active'] : ''}`} onClick={() => togglePdfSort('problematic')} title="Sort by problematic count" style={{ color: pdfSortKey === 'problematic' ? '#f59e0b' : undefined }}>
              !{pdfSortKey === 'problematic' && <span className={styles['sort-arrow']}>{pdfSortAsc ? '\u2191' : '\u2193'}</span>}
            </button>
            <button className={`${styles['sort-btn']} ${pdfSortKey === 'not_found' ? styles['sort-active'] : ''}`} onClick={() => togglePdfSort('not_found')} title="Sort by not found count" style={{ color: pdfSortKey === 'not_found' ? '#9ca3af' : undefined }}>
              &#x2715;{pdfSortKey === 'not_found' && <span className={styles['sort-arrow']}>{pdfSortAsc ? '\u2191' : '\u2193'}</span>}
            </button>
          </div>
        )}

        <div className={styles['verify-list']}>
          {pdfs.length === 0 ? (
            <div className={styles['empty-state']}>
              <p>No approved PDFs</p>
              <p className={styles['empty-sub']}>Approve sources in Parsing tab first</p>
            </div>
          ) : (
            sortedPdfs.map(pdf => {
              const summary = summaries[pdf.id]
              const pdfVerifying = isPdfVerifying(pdf.id)
              const hasPdfResults = Object.keys(resultsByPdf[pdf.id] ?? {}).length > 0
              return (
                <div
                  key={pdf.id}
                  className={`${styles['verify-item']} ${effectivePdfId === pdf.id ? styles['verify-selected'] : ''}`}
                  onClick={() => selectPdf(pdf.id)}
                >
                  <div className={styles['verify-item-top']}>
                    {pdfVerifying ? (
                      <span className={`${styles['vi-status']} ${styles['vi-spin']}`}>&#x25CC;</span>
                    ) : hasPdfResults ? (
                      <span className={styles['vi-status']} style={{ color: '#22c55e' }}>&#x2713;</span>
                    ) : (
                      <span className={styles['vi-status']} style={{ color: '#a8a29e' }}>&#x25CB;</span>
                    )}
                    <span className={styles['vi-name']}>{pdf.name}</span>
                    <button
                      className={styles['vi-verify-btn']}
                      onClick={(e) => { e.stopPropagation(); handleVerifyOrCancelPdf(pdf.id) }}
                      title={isPdfVerifying(pdf.id) ? "Stop verification" : "Verify this PDF"}
                    >{isPdfVerifying(pdf.id) ? '\u25A0' : '\u25B6'}</button>
                  </div>
                  {summary && (
                    <div className={styles['verify-counts']}>
                      <span className={`${styles['vc']} ${styles['vc-found']}`}>{summary.found}</span>
                      <span className={`${styles['vc']} ${styles['vc-problematic']}`}>{summary.problematic}</span>
                      <span className={`${styles['vc']} ${styles['vc-not-found']}`}>{summary.not_found}</span>
                    </div>
                  )}
                </div>
              )
            })
          )}
        </div>
      </aside>

      {/* Center Panel: Source Card List */}
      <section className={styles['verify-center']} ref={verifyCenterRef}>
        {!effectivePdfId ? (
          <div className={styles['center-empty']}>
            <div className={styles['center-empty-icon']}>&#x25C9;</div>
            <p>Select a PDF to verify sources</p>
          </div>
        ) : orderedSources.length === 0 ? (
          <div className={styles['center-empty']}>
            <p>No sources found for this PDF</p>
          </div>
        ) : (
          <>
            {/* Toolbar */}
            <div className={styles['card-toolbar']}>
              <div className={styles['toolbar-left']}>
                <button
                  className={styles['toolbar-btn']}
                  onClick={() => effectivePdfId && setAllEnabled(effectivePdfId, !areAllSourcesEnabled)}
                >
                  {areAllSourcesEnabled ? 'Disable All' : 'Enable All'}
                </button>
                <button
                  className={`${styles['toolbar-btn']} ${styles['toolbar-btn-accent']}`}
                  onClick={() => effectivePdfId && handleVerifyNonFoundPdf(effectivePdfId)}
                  disabled={!effectivePdfId || (effectivePdfId ? isPdfVerifying(effectivePdfId) : true)}
                  title="Verify only non-Found sources"
                >NF</button>
                <button
                  className={`${styles['toolbar-btn']} ${styles['toolbar-btn-accent']}`}
                  onClick={() => handleScholarScanPdf()}
                  disabled={scholarStatus === 'scanning' || !effectivePdfId}
                  title="Google Scholar scan for non-Found sources"
                >GS</button>
              </div>
              <div className={styles['toolbar-center']}>
                <span className={styles['toolbar-count']}>{enabledCount}/{orderedSources.length} enabled</span>
              </div>
              <div className={styles['toolbar-right']}>
                <button className={`${styles['toolbar-btn']} ${cardSortKey === 'status' ? styles['sort-active'] : ''}`} onClick={() => toggleCardSort('status')}>
                  Status{cardSortKey === 'status' && <span className={styles['sort-arrow']}>{cardSortAsc ? '\u2191' : '\u2193'}</span>}
                </button>
                <button className={`${styles['toolbar-btn']} ${cardSortKey === 'ref' ? styles['sort-active'] : ''}`} onClick={() => toggleCardSort('ref')}>
                  Ref#{cardSortKey === 'ref' && <span className={styles['sort-arrow']}>{cardSortAsc ? '\u2191' : '\u2193'}</span>}
                </button>
                <button className={`${styles['toolbar-btn']} ${cardSortKey === 'enabled' ? styles['sort-active'] : ''}`} onClick={() => toggleCardSort('enabled')}>
                  Enabled{cardSortKey === 'enabled' && <span className={styles['sort-arrow']}>{cardSortAsc ? '\u2191' : '\u2193'}</span>}
                </button>
                {cardSortKey !== 'default' && (
                  <button className={styles['toolbar-btn']} onClick={() => toggleCardSort('default')}>&#x21BA;</button>
                )}
              </div>
            </div>

            {/* Source cards */}
            <div className={styles['card-list']} ref={cardListRef} data-scrollable>
              {sortedSourceCards.map((card, idx) => {
                const isSelected = selectedSourceId === card.source.id
                const cardClass = [
                  styles['source-card'],
                  isSelected ? styles['card-selected'] : '',
                  !card.enabled ? styles['card-disabled'] : '',
                  dropTargetIdx === idx && dragSourceId !== card.source.id ? styles['card-dragover'] : '',
                ].filter(Boolean).join(' ')

                return (
                  <div
                    key={card.source.id}
                    ref={(el) => { cardRefs.current[card.source.id] = el }}
                    className={cardClass}
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
                        <span className={styles['ref-badge']}>[{card.source.ref_number ?? '?'}]</span>
                        <label className={styles['toggle-label']}>
                          <input
                            type="checkbox"
                            checked={card.enabled}
                            className={styles['toggle-check']}
                            onClick={(e) => e.stopPropagation()}
                            onChange={(e) => { e.stopPropagation(); toggleSourceEnabled(card.source.id) }}
                          />
                        </label>
                        <span
                          className={styles['drag-handle']}
                          draggable
                          onDragStart={(e) => { e.stopPropagation(); onDragStart(e, card.source.id) }}
                          onDragEnd={onDragEnd}
                          onPointerDown={(e) => e.stopPropagation()}
                          title="Drag to reorder"
                          aria-hidden="true"
                        >&#x2807;</span>
                        <span className={styles['card-actions']}>
                          <button
                            className={styles['copy-btn']}
                            onClick={(e) => {
                              e.stopPropagation()
                              const text = verifyTexts[card.source.id] ?? sanitizeReferenceText(card.source.text)
                              navigator.clipboard.writeText(text)
                            }}
                            title="Copy text"
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
                                resetVerifyText(card.source.id)
                              }}
                              title="Reset to original text"
                            >&#x21BA;</button>
                          )}
                        </span>
                        <span className={styles['card-status-group']}>
                          {((card.result?.problem_tags && card.result.problem_tags.length > 0) ||
                            (card.result && card.result.status !== 'found' && card.result.best_match && card.result.best_match.match_details.title_similarity > 0.75)) && (
                            <span className={styles['problem-tags']}>
                              {card.result && card.result.status !== 'found' && card.result.best_match && card.result.best_match.match_details.title_similarity > 0.75 && (
                                <span className={styles['title-tag']} title={`Title similarity ${Math.round(card.result.best_match.match_details.title_similarity * 100)}%`}>
                                  title: {Math.round(card.result.best_match.match_details.title_similarity * 100)}%
                                </span>
                              )}
                              {card.result?.problem_tags?.map((tag) => (
                                <span key={tag} className={styles['problem-tag']} title={problemTagDescription(tag)}>
                                  {tag}
                                </span>
                              ))}
                            </span>
                          )}
                          {card.result && (
                            <span className={styles['status-badge']} style={{ background: statusColor(card.result), color: 'white' }}>
                              {statusLabel(card.result)}
                            </span>
                          )}
                        </span>
                      </div>

                      {/* Textarea */}
                      <textarea
                        className={styles['card-textarea']}
                        value={verifyTexts[card.source.id] ?? sanitizeReferenceText(card.source.text)}
                        onInput={(e) => {
                          const el = e.target as HTMLTextAreaElement
                          setVerifyText(card.source.id, el.value)
                          autoResize(el)
                        }}
                        onFocus={(e) => autoResize(e.target as HTMLTextAreaElement)}
                        onClick={(e) => e.stopPropagation()}
                        rows={2}
                        disabled={!card.enabled}
                      />

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
                  Scholar: {scholarCurrentIndex}/{scholarTotal} checked, {scholarFoundCount} gave results
                </span>
                {scholarStatus === 'captcha' && (
                  <button className={styles['action-btn']} onClick={() => useScholarScanStore.getState().resumeAfterCaptcha()}>
                    Resume
                  </button>
                )}
                <button className={styles['action-btn']} onClick={() => useScholarScanStore.getState().cancelScan()}>
                  Cancel
                </button>
              </div>
            )}

            {browserOverlayOpen && (
              <div className={styles['scholar-overlay']} style={{ height: `${browserOverlayHeight}px` }} ref={browserOverlayRef}>
                {scholarStatus === 'captcha' && (
                  <div className={styles['scholar-captcha-banner']}>
                    CAPTCHA detected — please solve it below. Scan will resume automatically, or close Webview and click Resume.
                  </div>
                )}
                <div className={styles['scholar-overlay-resizer']} onMouseDown={startOverlayResize} title="Drag to resize">
                  <span className={styles['scholar-overlay-resizer-line']} />
                </div>
                <div className={styles['scholar-overlay-header']}>
                  <div className={styles['scholar-overlay-nav-actions']}>
                    <button
                      className={`${styles['action-btn']} ${styles['overlay-icon-btn']}`}
                      onClick={goBrowserBack}
                      disabled={!browserCanGoBack}
                      title="Go back"
                      aria-label="Go back"
                    >
                      <svg className={styles['overlay-icon']} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M10.5 3.5L5.5 8l5 4.5" />
                      </svg>
                    </button>
                    <button
                      className={`${styles['action-btn']} ${styles['overlay-icon-btn']}`}
                      onClick={goBrowserForward}
                      disabled={!browserCanGoForward}
                      title="Go forward"
                      aria-label="Go forward"
                    >
                      <svg className={styles['overlay-icon']} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M5.5 3.5L10.5 8l-5 4.5" />
                      </svg>
                    </button>
                    <button
                      className={`${styles['action-btn']} ${styles['overlay-icon-btn']}`}
                      onClick={reloadBrowserView}
                      title="Reload page"
                      aria-label="Reload page"
                    >
                      <svg className={styles['overlay-icon']} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M13 4.5v3h-3" />
                        <path d="M12.4 7.5A5 5 0 103.8 11" />
                      </svg>
                    </button>
                  </div>
                  <div className={styles['scholar-overlay-zoom-actions']}>
                    <button
                      className={`${styles['action-btn']} ${styles['overlay-zoom-btn']}`}
                      onClick={zoomBrowserOut}
                      title="Zoom out (Ctrl + -)"
                      aria-label="Zoom out"
                    >-</button>
                    <button
                      className={`${styles['action-btn']} ${styles['overlay-zoom-readout']}`}
                      onClick={resetBrowserZoom}
                      title="Reset zoom (Ctrl + 0)"
                      aria-label="Reset zoom"
                    >{Math.round(browserZoomFactor * 100)}%</button>
                    <button
                      className={`${styles['action-btn']} ${styles['overlay-zoom-btn']}`}
                      onClick={zoomBrowserIn}
                      title="Zoom in (Ctrl + +)"
                      aria-label="Zoom in"
                    >+</button>
                  </div>
                  <div className={styles['scholar-overlay-actions']}>
                    <button
                      className={`${styles['action-btn']} ${styles['overlay-icon-btn']}`}
                      onClick={() => openExternal(browserOverlayUrl)}
                      title="Open in external browser"
                      aria-label="Open in external browser"
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
                      title="Close browser panel"
                      aria-label="Close browser panel"
                    >
                      <svg className={styles['overlay-icon']} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M4.5 4.5l7 7" />
                        <path d="M11.5 4.5l-7 7" />
                      </svg>
                    </button>
                  </div>
                </div>
                <webview
                  ref={browserWebviewRef}
                  className={styles['scholar-overlay-webview']}
                  src={browserOverlayUrl}
                  partition="persist:scholar-panel"
                  allowpopups={true}
                />
              </div>
            )}

            {/* Hidden webview for Scholar scanner */}
            <webview
              ref={scholarScanWebviewRef}
              src="about:blank"
              partition="persist:scholar-panel"
              style={{ position: 'fixed', left: '-9999px', top: '0', width: '1280px', height: '800px', opacity: 0, pointerEvents: 'none' } as React.CSSProperties}
            />
          </>
        )}
      </section>

      {/* Right Panel: Source Detail */}
      <aside className={styles['verify-right']} onMouseDownCapture={() => browserOverlayOpen && closeBrowserOverlay()}>
        <div className={styles['detail-body']}>
          {selectedSourceId ? (() => {
            const r = currentResult
            const hasCompletedResult = Boolean(r && r.status !== 'in_progress')
            return (
              <>
                {/* Top actions */}
                <div className={styles['detail-top-row']}>
                  <button
                    className={styles['detail-ref-badge']}
                    onClick={() => {
                      const el = cardRefs.current[selectedSourceId]
                      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
                    }}
                    title="Scroll to card"
                  >[{currentSource?.ref_number ?? '?'}]</button>
                  <div className={styles['detail-actions']}>
                    <button
                      className={`${styles['override-btn']} ${styles['override-found']} ${r?.status === 'found' ? styles['override-found-active'] : ''}`}
                      disabled={!r || r.status === 'in_progress'}
                      onClick={() => handleOverride('found')} title="Mark as found"
                    >&#x2713;</button>
                    <button
                      className={`${styles['override-btn']} ${styles['override-problematic']} ${r?.status === 'problematic' ? styles['override-problematic-active'] : ''}`}
                      disabled={!r || r.status === 'in_progress'}
                      onClick={() => handleOverride('problematic')} title="Mark as problematic"
                    >!</button>
                    <button
                      className={`${styles['override-btn']} ${styles['override-not-found']} ${r?.status === 'not_found' ? styles['override-not-found-active'] : ''}`}
                      disabled={!r || r.status === 'in_progress'}
                      onClick={() => handleOverride('not_found')} title="Mark as not found"
                    >X</button>
                  </div>
                </div>

                <div className={styles['detail-search-actions']}>
                  <button
                    className={`${styles['action-btn']} ${styles['detail-search-btn']}`}
                    onClick={openScholarOverlay}
                    disabled={!selectedSearchText}
                    title="Open Google Scholar in middle panel"
                  >Google Scholar</button>
                  <button
                    className={`${styles['action-btn']} ${styles['detail-search-btn']}`}
                    onClick={openGoogleOverlay}
                    disabled={!selectedSearchText}
                    title="Open Google Search in middle panel"
                  >Google Search</button>
                </div>

                <div className={styles['section-header-row']}>
                  <div className={styles['section-title']}>Best Match</div>
                  <div className={styles['result-summary']}>
                    <button className={`${styles['action-btn']} ${styles['action-btn-accent']}`} onClick={handleReverifyOrCancelSource} title={currentResult?.status === 'in_progress' ? "Stop verification" : "Verify this source"}>
                      {currentResult?.status === 'in_progress' ? <><span>&#x25A0;</span> Stop</> : <><span>&#x21BB;</span> Verify</>}
                    </button>
                  </div>
                </div>

                {hasCompletedResult && r && (
                  <>
                    {r.best_match ? (
                      <div className={styles['match-card']}>
                        <div className={styles['match-title']}>{r.best_match.title}</div>
                        {r.best_match.authors.length > 0 && (
                          <div className={styles['match-meta']}>{r.best_match.authors.join(', ')}</div>
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
                          <button className={styles['match-link']} onClick={() => openOverlayWithUrl(r.best_match!.url)}>Open source &#x2197;</button>
                        )}
                      </div>
                    ) : (
                      <div className={styles['match-empty']}>No match found</div>
                    )}

                    {/* All database results */}
                    <div className={styles['section-title']}>Database Results</div>
                    <div className={styles['detail-db-list']}>
                      {[...enabledDatabases, ...(r.databases_searched.includes('Google Scholar') ? ['Google Scholar'] : [])].map(db => {
                        const match = r.all_results.find((m: MatchResult) => m.database === db)
                        const searched = r.databases_searched.includes(db)
                        const dbCheck = selectedProgress?.checkedDbs.find(d => d.name === db)
                        const searchText = r.best_match?.title ?? verifyTexts[selectedSourceId] ?? currentSource?.text ?? ''
                        const linkUrl = buildDbSearchUrl(db, searchText) || match?.search_url || dbCheck?.searchUrl
                        return (
                          <div key={db} className={styles['db-row']}>
                            <span className={styles['db-icon']} style={{ color: match ? dbScoreColor(match.score) : searched ? '#a8a29e' : '#d6d3d1' }}>
                              {match ? dbScoreIcon(match.score) : searched ? '\u2715' : '\u25CB'}
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
                        <div className={styles['section-title']}>URL Status</div>
                        <ul className={styles['url-list']}>
                          {Object.entries(r.url_liveness).map(([url, alive]) => (
                            <li key={url} className={styles['url-item']}>
                              <span
                                className={styles['url-dot']}
                                style={{ background: alive ? '#22c55e' : '#ef4444' }}
                                title={alive ? 'Reachable' : 'Dead link'}
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
              <p>Select a source to see details</p>
            </div>
          )}
        </div>
      </aside>
    </div>
  )
}
