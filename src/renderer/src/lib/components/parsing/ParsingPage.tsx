import {
  useState,
  useMemo,
  useEffect,
  useLayoutEffect,
  useRef,
  useCallback,
} from "react";
import type { PDFDocumentProxy } from "pdfjs-dist/types/src/display/api";
import { usePdfStore } from "../../stores/pdf-store";
import {
  useSourcesStore,
  loadSources,
  addRectangle,
  removeRectangle,
  updateRectangle,
  beginEdit,
  updateRectangleSilent,
  revert,
  revertToOriginal,
  saveSources,
  approveSources,
  unapproveSources,
  clearSourcesForPdf,
  mergeWithClosest,
} from "../../stores/sources-store";
import { clearVerificationForPdf } from "../../stores/verification-store";
import type { SourceRectangle, PageData, ParsedSource } from "../../api/types";
import { api } from "../../api/rest-client";
import { getPdfjs } from "../../pdf/pdfjs-setup";
import { SCALE } from "../../pdf/types";
import { writeNotesToPdf } from "../../pdf/annotation-writer";
import { extractTextInBbox } from "../../pdf/extract-text";
import {
  addNote,
  getNotes,
  removeNote,
  setActiveColor,
  setActiveKind,
  updateNote,
  useNotesStore,
  DEFAULT_CALLOUT_FONT_SIZE,
  CALLOUT_FONT_SIZE_MIN,
  CALLOUT_FONT_SIZE_MAX,
} from "../../stores/notes-store";
import { useSettingsStore } from "../../stores/settings-store";
import { NotesLayer } from "./NotesLayer";
import { PdfPageCanvas } from "./PdfPageCanvas";
import styles from "./ParsingPage.module.css";

const statusOrder: Record<string, number> = {
  approved: 0,
  parsed: 1,
  parsing: 2,
  pending: 3,
  error: 4,
};

function buildDefaultSavePath(dir: string | undefined, filename: string): string {
  const trimmed = dir?.trim()
  if (!trimmed) return filename
  const sep = trimmed.includes('\\') ? '\\' : '/'
  const stripped = trimmed.replace(/[\\/]+$/, '')
  return `${stripped}${sep}${filename}`
}

function statusIcon(status: string): string {
  switch (status) {
    case "approved":
      return "\u2713";
    case "parsed":
      return "?";
    case "parsing":
      return "\u25CC";
    case "error":
      return "\u2715";
    default:
      return "\u25CC";
  }
}

function statusColorStyle(status: string): string {
  switch (status) {
    case "approved":
      return "#22c55e";
    case "parsed":
      return "#eab308";
    case "error":
      return "#ef4444";
    default:
      return "#a8a29e";
  }
}

export default function ParsingPage() {
  const allPdfs = usePdfStore((s) => s.pdfs);
  const pdfPathsById = usePdfStore((s) => s.pathsById);
  const selectedPdfId = usePdfStore((s) => s.selectedPdfId);
  const loading = usePdfStore((s) => s.loading);
  const selectPdf = usePdfStore((s) => s.selectPdf);
  const removePdf = usePdfStore((s) => s.removePdf);
  const sortKey = usePdfStore((s) => s.parsingSortKey);
  const sortAsc = usePdfStore((s) => s.parsingSortAsc);
  const { toggleParsingSort } = usePdfStore.getState();

  const sourcesByPdf = useSourcesStore((s) => s.sourcesByPdf);
  const historyByPdf = useSourcesStore((s) => s.historyByPdf);

  const notesByPdf = useNotesStore((s) => s.notesByPdf);
  const activeNoteKind = useNotesStore((s) => s.activeKind);
  const activeNoteColor = useNotesStore((s) => s.activeColor);
  const notes = useMemo(
    () => (selectedPdfId ? (notesByPdf[selectedPdfId] ?? []) : []),
    [notesByPdf, selectedPdfId],
  );
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const [exportingPdf, setExportingPdf] = useState(false);

  const selectedPdf = useMemo(
    () => allPdfs.find((p) => p.id === selectedPdfId),
    [allPdfs, selectedPdfId],
  );
  const sources = useMemo(
    () => (selectedPdfId ? (sourcesByPdf[selectedPdfId] ?? []) : []),
    [sourcesByPdf, selectedPdfId],
  );
  const canRevertCurrent = useMemo(() => {
    if (!selectedPdfId) return false;
    const h = historyByPdf[selectedPdfId];
    return h ? h.length > 0 : false;
  }, [historyByPdf, selectedPdfId]);
  const isApproved = selectedPdf?.status === "approved";

  // Local state
  const [pages, setPages] = useState<PageData[]>([]);
  const [loadingPages, setLoadingPages] = useState(false);
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
  const [scale, setScale] = useState(1);
  const [containerWidth, setContainerWidth] = useState(0);
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
  const [manualCounter, setManualCounter] = useState(0);
  const [parsedFields, setParsedFields] = useState<ParsedSource | null>(null);
  const [parsedFieldsLoading, setParsedFieldsLoading] = useState(false);
  const parsedFieldsCache = useRef<Record<string, ParsedSource>>({});
  const [rawTextExpanded, setRawTextExpanded] = useState(true);

  // Refs for interaction state (not reactive, no re-render needed)
  const viewerRef = useRef<HTMLDivElement>(null);
  const loadedPdfIdRef = useRef<string | null>(null);
  // Set by loadPdfPages when a new batch of pages is about to mount; the
  // useLayoutEffect below consumes it to apply fit-to-width before paint.
  const pendingFitRef = useRef(false);
  const suppressPageClickRef = useRef(false);
  const dragIntentRef = useRef<{
    sourceId: string;
    startX: number;
    startY: number;
    origBbox: { x0: number; y0: number; x1: number; y1: number; page: number };
  } | null>(null);
  const dragStartedRef = useRef(false);
  const resizingRef = useRef<{
    sourceId: string;
    handle: string;
    startX: number;
    startY: number;
    origBbox: { x0: number; y0: number; x1: number; y1: number; page: number };
  } | null>(null);
  const drawingRef = useRef<{
    page: number;
    startX: number;
    startY: number;
    currentX: number;
    currentY: number;
  } | null>(null);
  const pendingScrollRef = useRef<{ left: number; top: number } | null>(null);
  const [drawingState, setDrawingState] = useState<{
    page: number;
    startX: number;
    startY: number;
    currentX: number;
    currentY: number;
  } | null>(null);

  // Sorting
  const toggleSort = toggleParsingSort;

  const sortedPdfs = useMemo(() => {
    // While an import batch is running, preserve insertion order (which
    // matches the user's alphabetical file selection). The default sort key
    // is `numbered`, and parse completions flip PDFs from unnumbered to
    // numbered one by one, which caused the list to jump around mid-import.
    if (loading) return allPdfs;

    const list = [...allPdfs];
    const dir = sortAsc ? 1 : -1;
    list.sort((a, b) => {
      if (sortKey === "name") return dir * a.name.localeCompare(b.name);
      if (sortKey === "status")
        return (
          dir * ((statusOrder[a.status] ?? 9) - (statusOrder[b.status] ?? 9))
        );
      if (sortKey === "numbered") {
        // Unnumbered first (ascending): unnumbered=0, numbered=1
        const diff = (a.numbered ? 1 : 0) - (b.numbered ? 1 : 0);
        if (diff !== 0) return dir * diff;
        return a.name.localeCompare(b.name);
      }
      return dir * (a.source_count - b.source_count);
    });
    return list;
  }, [allPdfs, sortKey, sortAsc, loading]);

  // Scroll-based virtualisation: only mount PdfPageCanvas for pages whose
  // scaled bounds intersect the visible viewport (plus a 1-page buffer).
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

  useEffect(() => {
    const el = viewerRef.current;
    if (!el) return;
    setViewportHeight(el.clientHeight);
    const onScroll = () => setScrollTop(el.scrollTop);
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [selectedPdfId, pages.length, loadingPages]);

  // Page layout computations
  const maxPageWidth = useMemo(
    () => (pages.length > 0 ? Math.max(...pages.map((p) => p.width)) : 0),
    [pages],
  );
  const fitScale = useMemo(
    () =>
      containerWidth > 0 && maxPageWidth > 0
        ? Math.min((containerWidth - 40) / maxPageWidth, 2)
        : 1,
    [containerWidth, maxPageWidth],
  );
  const pageOffsets = useMemo(() => {
    const offsets: number[] = [0];
    for (let i = 0; i < pages.length - 1; i++) {
      offsets.push(offsets[i] + pages[i].height);
    }
    return offsets;
  }, [pages]);
  const totalHeight = useMemo(
    () => pages.reduce((sum, p) => sum + p.height, 0),
    [pages],
  );
  const zoomPercent = Math.round(scale * 100);

  // Determine which page indices are within the visible scroll viewport
  // (plus a 1-page buffer above/below) so we can skip rendering off-screen
  // pages entirely.
  const visiblePageIndices = useMemo(() => {
    if (pages.length === 0 || viewportHeight === 0) return new Set<number>();
    const vTop = scrollTop / scale;
    const vBottom = (scrollTop + viewportHeight) / scale;
    const visible = new Set<number>();
    for (let i = 0; i < pages.length; i++) {
      const pTop = pageOffsets[i];
      const pBottom = pTop + pages[i].height;
      // 1-page buffer: include neighbouring pages so they're ready when
      // the user scrolls a little further.
      const bufferAbove = i > 0 ? pages[i - 1].height : 0;
      const bufferBelow = i < pages.length - 1 ? pages[i + 1].height : 0;
      if (pBottom + bufferBelow >= vTop && pTop - bufferAbove <= vBottom) {
        visible.add(i);
      }
    }
    return visible;
  }, [pages, pageOffsets, scrollTop, viewportHeight, scale]);

  // Auto fit-to-width on new PDF load. Must be useLayoutEffect (not useEffect)
  // so the setScale flush happens *before* the browser paints — otherwise
  // React commits the new pages at the previous scale, paints once, then
  // re-renders with the corrected scale, producing a visible "100% → fit"
  // jump. Only runs when pendingFitRef is set (i.e. right after loadPdfPages
  // commits new pages), so user-initiated zoom isn't overwritten.
  useLayoutEffect(() => {
    if (!pendingFitRef.current) return;
    if (pages.length === 0) return;
    const container = viewerRef.current;
    if (!container) return;
    const cw = container.clientWidth;
    const maxW = Math.max(...pages.map((p) => p.width));
    if (cw > 0 && maxW > 0) {
      setScale(Math.min((cw - 40) / maxW, 2));
      pendingFitRef.current = false;
    }
    // If cw is still 0 (container not laid out yet), leave the flag set so
    // the next render triggered by containerWidth changing will retry.
  }, [pages, containerWidth]);

  // ResizeObserver
  useEffect(() => {
    const el = viewerRef.current;
    if (!el) {
      setContainerWidth(0);
      return;
    }
    setContainerWidth(el.clientWidth);
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width);
        setViewportHeight(entry.contentRect.height);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [selectedPdfId, pages.length, loadingPages]);

  // Load pages when selected PDF changes
  useEffect(() => {
    const pdfId = selectedPdfId;
    const status = selectedPdf?.status;
    if (pdfId && status !== "pending" && status !== "parsing") {
      if (pdfId !== loadedPdfIdRef.current) {
        loadedPdfIdRef.current = pdfId;
        void loadPdfPages(pdfId);
      }
    } else {
      setPages([]);
      loadedPdfIdRef.current = null;
    }
  }, [selectedPdfId, selectedPdf?.status]);

  // Release the pdfjs-dist document when the component unmounts so the WASM
  // worker backing it can clean up its native buffers.
  useEffect(() => {
    return () => {
      setPdfDoc((prev) => {
        if (prev) void prev.destroy();
        return null;
      });
    };
  }, []);

  async function loadPdfPages(pdfId: string) {
    setLoadingPages(true);
    setSelectedSourceId(null);
    // Tear down any previously loaded pdfjs-dist document.
    setPdfDoc((prev) => {
      if (prev) void prev.destroy();
      return null;
    });
    try {
      const localPath = pdfPathsById[pdfId];
      if (!localPath) {
        console.warn(
          `[ParsingPage] no local path for ${pdfId}; cannot render`,
        );
        setPages([]);
        return;
      }

      // Load the PDF bytes and hand them to pdfjs-dist. We pass the buffer
      // directly (pdfjs transfers ownership to its worker).
      const bytes = await window.electronAPI.readPdfFile(localPath);
      const pdfjsLib = getPdfjs();
      const doc = await pdfjsLib.getDocument({ data: bytes }).promise;

      // Guard against rapid PDF switches.
      if (usePdfStore.getState().selectedPdfId !== pdfId) {
        await doc.destroy();
        return;
      }

      // Fast path: get the first page's dimensions and assume all pages
      // share them (true for virtually all academic papers). This lets us
      // render immediately instead of waiting for every page proxy.
      const firstPage = await doc.getPage(1);
      const firstVp = firstPage.getViewport({ scale: SCALE });
      firstPage.cleanup();
      const w = firstVp.width;
      const h = firstVp.height;

      const pageDataList: PageData[] = Array.from(
        { length: doc.numPages },
        (_, i) => ({ page_num: i, width: w, height: h }),
      );

      // Mark this load as needing an initial fit; the useLayoutEffect below
      // picks it up after React commits the new pages to the DOM and applies
      // the fit-to-width scale before the browser paints — so there is no
      // visible "100% then fit" jump when switching PDFs.
      pendingFitRef.current = true;
      setPages(pageDataList);
      setPdfDoc(doc);

      // Background: verify that remaining pages actually share the same
      // dimensions. If any differ, patch the page list so layout is exact.
      if (doc.numPages > 1) {
        const corrections: { idx: number; width: number; height: number }[] = [];
        await Promise.all(
          Array.from({ length: doc.numPages - 1 }, async (_, i) => {
            const pg = await doc.getPage(i + 2);
            const vp = pg.getViewport({ scale: SCALE });
            pg.cleanup();
            if (Math.abs(vp.width - w) > 1 || Math.abs(vp.height - h) > 1) {
              corrections.push({ idx: i + 1, width: vp.width, height: vp.height });
            }
          }),
        );
        if (corrections.length > 0 && usePdfStore.getState().selectedPdfId === pdfId) {
          setPages((prev) => {
            const next = [...prev];
            for (const c of corrections) {
              next[c.idx] = { ...next[c.idx], width: c.width, height: c.height };
            }
            return next;
          });
        }
      }

      // Sources: the orchestrator has already populated the local store on
      // import, but if the user opens a PDF that was imported in a prior
      // session the store may be empty — fall back to the cache endpoint
      // in that case. This mirrors the old `getSources` seeding.
      if (!useSourcesStore.getState().sourcesByPdf[pdfId]) {
        await loadSources(pdfId);
      }
    } catch (e) {
      console.error("Failed to load PDF pages:", e);
      setPages([]);
    } finally {
      setLoadingPages(false);
    }
  }

  async function handleImport() {
    try {
      let defaultPath: string | undefined;
      try {
        const lastDirectoryResponse = await api.getLastDirectory();
        defaultPath = lastDirectoryResponse.directory?.trim()
          ? lastDirectoryResponse.directory
          : undefined;
      } catch {
        defaultPath = undefined;
      }
      const files = await window.electronAPI.selectPdfs(defaultPath);
      if (files.length > 0) {
        await usePdfStore.getState().loadFiles(files);
      }
    } catch {
      const dir = prompt("Enter PDF directory path:");
      if (dir) await usePdfStore.getState().loadDirectory(dir);
    }
  }

  function handleRemovePdf(pdfId: string) {
    const pdf = allPdfs.find((p) => p.id === pdfId);
    if (!pdf) return;

    if (selectedPdfId === pdfId) {
      setSelectedSourceId(null);
    }

    const pdfSources = useSourcesStore.getState().sourcesByPdf[pdfId] ?? [];
    for (const s of pdfSources) {
      delete parsedFieldsCache.current[s.id];
    }

    clearSourcesForPdf(pdfId);
    clearVerificationForPdf(pdfId);
    removePdf(pdfId);
  }

  async function handleApprove() {
    if (!selectedPdfId) return;
    await toggleApproval(selectedPdfId);
  }

  async function toggleApproval(pdfId: string) {
    const pdf = usePdfStore.getState().pdfs.find((p) => p.id === pdfId);
    if (!pdf || pdf.status === "pending" || pdf.status === "parsing") return;
    if (pdf.status === "approved") {
      await unapproveSources(pdfId);
      usePdfStore.getState().updatePdfStatus(pdfId, "parsed");
    } else {
      let existingSources = useSourcesStore.getState().sourcesByPdf[pdfId];
      if (!existingSources) {
        await loadSources(pdfId);
        existingSources = useSourcesStore.getState().sourcesByPdf[pdfId];
      }
      if (!existingSources) {
        console.warn(`Could not load sources for ${pdfId}; skipping approve.`);
        return;
      }
      await saveSources(pdfId);
      await approveSources(pdfId);
      usePdfStore.getState().updatePdfStatus(pdfId, "approved");
    }
  }

  function handleRevert() {
    if (!selectedPdfId) return;
    const pdfId = selectedPdfId;
    revert(pdfId);
    void saveSources(pdfId).catch((err) => {
      console.error("Undo save failed:", err);
    });
  }

  async function handleRevertToOriginal() {
    if (!selectedPdfId) return;
    await revertToOriginal(selectedPdfId);
    setSelectedSourceId(null);
  }

  function handleRemoveSource(sourceId: string) {
    if (!selectedPdfId) return;
    removeRectangle(selectedPdfId, sourceId);
    if (selectedSourceId === sourceId) setSelectedSourceId(null);
    saveSources(selectedPdfId);
  }

  function sourcesForPage(pageNum: number): SourceRectangle[] {
    return sources.filter((s) => s.bbox.page === pageNum);
  }

  function extraBboxesForPage(
    pageNum: number,
  ): { source: SourceRectangle; bbox: SourceRectangle["bbox"] }[] {
    const result: { source: SourceRectangle; bbox: SourceRectangle["bbox"] }[] =
      [];
    for (const s of sources) {
      if (s.bboxes && s.bboxes.length > 0) {
        for (const bb of s.bboxes) {
          if (bb.page === s.bbox.page) continue;
          if (bb.page === pageNum) result.push({ source: s, bbox: bb });
        }
      }
    }
    return result;
  }

  // Zoom
  function zoomIn() {
    const el = viewerRef.current;
    const oldScale = scaleRef.current;
    const newScale = Math.min(oldScale * 1.25, 3);
    if (el) {
      const ratio = newScale / oldScale;
      pendingScrollRef.current = {
        left: (el.scrollLeft + el.clientWidth / 2) * ratio - el.clientWidth / 2,
        top: (el.scrollTop + el.clientHeight / 2) * ratio - el.clientHeight / 2,
      };
    }
    setScale(newScale);
  }
  function zoomOut() {
    const el = viewerRef.current;
    const oldScale = scaleRef.current;
    const newScale = Math.max(oldScale / 1.25, 0.2);
    if (el) {
      const ratio = newScale / oldScale;
      pendingScrollRef.current = {
        left: (el.scrollLeft + el.clientWidth / 2) * ratio - el.clientWidth / 2,
        top: (el.scrollTop + el.clientHeight / 2) * ratio - el.clientHeight / 2,
      };
    }
    setScale(newScale);
  }
  function zoomFit() {
    setScale(fitScale);
  }

  const onWheel = useCallback((e: WheelEvent) => {
    if (e.ctrlKey) {
      e.preventDefault();
      const el = viewerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const oldScale = scaleRef.current;
      const factor = e.deltaY > 0 ? 1 / 1.1 : 1.1;
      const newScale = Math.min(Math.max(oldScale * factor, 0.2), 3);
      const ratio = newScale / oldScale;
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      pendingScrollRef.current = {
        left: (el.scrollLeft + mouseX) * ratio - mouseX,
        top: (el.scrollTop + mouseY) * ratio - mouseY,
      };
      setScale(newScale);
    }
  }, []);

  useEffect(() => {
    const el = viewerRef.current;
    if (!el) return;
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [onWheel, selectedPdfId, pages.length, loadingPages]);

  // Apply scroll correction after scale changes to keep zoom anchored
  useLayoutEffect(() => {
    if (pendingScrollRef.current && viewerRef.current) {
      const el = viewerRef.current;
      el.scrollLeft = pendingScrollRef.current.left;
      el.scrollTop = pendingScrollRef.current.top;
      pendingScrollRef.current = null;
    }
  }, [scale]);

  // Notes: highlight creation from text selection.
  //
  // Listens for pointerup anywhere on the viewer; if a non-collapsed selection
  // exists, walks its client rects, groups them by which page the rect lies
  // in, converts screen coords into page-local pixel coords (SCALE space),
  // and creates one highlight note per page with `quads` for each line.
  useEffect(() => {
    if (activeNoteKind !== "highlight") return;
    const container = viewerRef.current;
    if (!container || !selectedPdfId || !pdfDoc) return;

    function handlePointerUp() {
      if (!selectedPdfId || !container) return;
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
      const range = selection.getRangeAt(0);
      const clientRects = Array.from(range.getClientRects()).filter(
        (r) => r.width > 1 && r.height > 1,
      );
      if (clientRects.length === 0) return;

      // Each page wrapper is tagged with data-page-num via the PDF render loop.
      const pageEls = Array.from(
        container.querySelectorAll<HTMLElement>("[data-page-num]"),
      );
      if (pageEls.length === 0) return;

      interface PageHit {
        pageNum: number;
        quads: { x0: number; y0: number; x1: number; y1: number }[];
      }
      const byPage = new Map<number, PageHit>();

      for (const rect of clientRects) {
        // Find the topmost page element whose bounding rect contains this rect's center.
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        let hostEl: HTMLElement | null = null;
        for (const el of pageEls) {
          const r = el.getBoundingClientRect();
          if (cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom) {
            hostEl = el;
            break;
          }
        }
        if (!hostEl) continue;
        const pageNum = Number(hostEl.dataset.pageNum);
        if (Number.isNaN(pageNum)) continue;
        const hostRect = hostEl.getBoundingClientRect();
        // The page wrapper is sized `page.width * scale` × `page.height * scale`
        // (see render loop), so dividing client-space coords by the current
        // scale yields pixel coords in SCALE space — the same coordinate
        // space used by SourceRectangle bboxes and stored notes.
        const quad = {
          x0: (rect.left - hostRect.left) / scaleRef.current,
          y0: (rect.top - hostRect.top) / scaleRef.current,
          x1: (rect.right - hostRect.left) / scaleRef.current,
          y1: (rect.bottom - hostRect.top) / scaleRef.current,
        };
        const existing = byPage.get(pageNum);
        if (existing) existing.quads.push(quad);
        else byPage.set(pageNum, { pageNum, quads: [quad] });
      }

      for (const hit of byPage.values()) {
        const bbox = hit.quads.reduce(
          (acc, q) => ({
            x0: Math.min(acc.x0, q.x0),
            y0: Math.min(acc.y0, q.y0),
            x1: Math.max(acc.x1, q.x1),
            y1: Math.max(acc.y1, q.y1),
          }),
          hit.quads[0],
        );
        const text = selection.toString().trim();
        addNote({
          pdfId: selectedPdfId,
          pageNum: hit.pageNum,
          kind: "highlight",
          bbox,
          quads: hit.quads,
          text,
          color: useNotesStore.getState().activeColor,
        });
      }

      selection.removeAllRanges();
    }

    container.addEventListener("pointerup", handlePointerUp);
    return () => container.removeEventListener("pointerup", handlePointerUp);
  }, [activeNoteKind, selectedPdfId, pdfDoc]);

  function handleCreateCallout(
    pageNum: number,
    bbox: { x0: number; y0: number; x1: number; y1: number },
  ) {
    if (!selectedPdfId) return;
    // Create the callout with empty text and auto-select it so the inline
    // editor in the toolbar focuses. Electron disables window.prompt(),
    // so the editing UX lives in-page.
    const note = addNote({
      pdfId: selectedPdfId,
      pageNum,
      kind: "callout",
      bbox,
      text: "",
      color: useNotesStore.getState().activeColor,
    });
    setSelectedNoteId(note.id);
  }

  function handleDeleteSelectedNote() {
    if (!selectedPdfId || !selectedNoteId) return;
    removeNote(selectedPdfId, selectedNoteId);
    setSelectedNoteId(null);
  }

  function handleUpdateSelectedNoteText(text: string) {
    if (!selectedPdfId || !selectedNoteId) return;
    updateNote(selectedPdfId, selectedNoteId, { text });
  }

  const selectedNote = useMemo(
    () => notes.find((n) => n.id === selectedNoteId) ?? null,
    [notes, selectedNoteId],
  );

  async function handleExportAnnotatedPdf() {
    if (!selectedPdfId) return;
    const localPath = pdfPathsById[selectedPdfId];
    if (!localPath) {
      console.warn(
        "[ParsingPage] cannot export: original PDF path not known for",
        selectedPdfId,
      );
      return;
    }
    const pdfNotes = getNotes(selectedPdfId);
    if (pdfNotes.length === 0) {
      window.alert("No notes to export.");
      return;
    }
    setExportingPdf(true);
    try {
      const defaultName = `${selectedPdfId}-annotated.pdf`;
      const configuredDir = useSettingsStore
        .getState()
        .settings.annotated_pdf_dir?.trim();
      const defaultPath = buildDefaultSavePath(configuredDir, defaultName);
      const target = await window.electronAPI.showSaveAs({
        title: "Save annotated PDF",
        defaultPath,
        filters: [{ name: "PDF Files", extensions: ["pdf"] }],
      });
      if (!target) return;
      const bytes = await window.electronAPI.readPdfFile(localPath);
      const annotated = await writeNotesToPdf(bytes, pdfNotes);
      await window.electronAPI.writePdfFile(target, annotated);
    } catch (err) {
      console.error("[ParsingPage] annotated PDF export failed:", err);
      window.alert(
        `Export failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setExportingPdf(false);
    }
  }

  // Text extraction — pulls text from the already-loaded pdfjs-dist document
  // for the given bbox. Replaces the old backend /api/parse/extract-text call.
  async function extractAndSetText(
    pdfId: string,
    sourceId: string,
    bbox: { x0: number; y0: number; x1: number; y1: number; page: number },
  ) {
    const doc = pdfDocRef.current;
    if (!doc) return;
    try {
      const text = await extractTextInBbox(doc, bbox.page, bbox);
      if (text) {
        updateRectangle(pdfId, sourceId, { text });
        saveSources(pdfId);
      }
    } catch (e) {
      console.error("Failed to extract text:", e);
    }
  }

  // Mouse handlers - use refs to avoid stale closure issues
  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  const selectedPdfIdRef = useRef(selectedPdfId);
  selectedPdfIdRef.current = selectedPdfId;
  const pageOffsetsRef = useRef(pageOffsets);
  pageOffsetsRef.current = pageOffsets;
  const pdfDocRef = useRef(pdfDoc);
  pdfDocRef.current = pdfDoc;

  function onRectMouseDown(e: React.MouseEvent, source: SourceRectangle) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    suppressPageClickRef.current = true;
    setSelectedSourceId(source.id);
    if (!selectedPdfIdRef.current) return;
    dragIntentRef.current = {
      sourceId: source.id,
      startX: e.clientX,
      startY: e.clientY,
      origBbox: { ...source.bbox },
    };
    dragStartedRef.current = false;
  }

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    const pdfId = selectedPdfIdRef.current;
    const currentScale = scaleRef.current;

    if (dragIntentRef.current && pdfId) {
      const dx = e.clientX - dragIntentRef.current.startX;
      const dy = e.clientY - dragIntentRef.current.startY;
      if (!dragStartedRef.current && Math.abs(dx) + Math.abs(dy) > 3) {
        dragStartedRef.current = true;
        beginEdit(pdfId);
      }
      if (dragStartedRef.current) {
        const pdfDx = dx / currentScale;
        const pdfDy = dy / currentScale;
        const ob = dragIntentRef.current.origBbox;
        updateRectangleSilent(pdfId, dragIntentRef.current.sourceId, {
          bbox: {
            x0: ob.x0 + pdfDx,
            y0: ob.y0 + pdfDy,
            x1: ob.x1 + pdfDx,
            y1: ob.y1 + pdfDy,
            page: ob.page,
          },
        });
      }
    } else if (resizingRef.current && pdfId) {
      const dx = (e.clientX - resizingRef.current.startX) / currentScale;
      const dy = (e.clientY - resizingRef.current.startY) / currentScale;
      const ob = resizingRef.current.origBbox;
      let { x0, y0, x1, y1 } = ob;
      const h = resizingRef.current.handle;
      if (h.includes("w")) x0 = Math.min(ob.x0 + dx, x1 - 10);
      if (h.includes("e")) x1 = Math.max(ob.x1 + dx, x0 + 10);
      if (h.includes("n")) y0 = Math.min(ob.y0 + dy, y1 - 10);
      if (h.includes("s")) y1 = Math.max(ob.y1 + dy, y0 + 10);
      updateRectangleSilent(pdfId, resizingRef.current.sourceId, {
        bbox: { x0, y0, x1, y1, page: ob.page },
      });
    } else if (drawingRef.current) {
      drawingRef.current = {
        ...drawingRef.current,
        currentX: e.clientX,
        currentY: e.clientY,
      };
      setDrawingState({ ...drawingRef.current });
    }
  }, []);

  const onMouseUp = useCallback((e: React.MouseEvent) => {
    // Drawing (right-click hold) should only finish on right-button release
    if (drawingRef.current && e.button !== 2) return;
    const pdfId = selectedPdfIdRef.current;
    const currentScale = scaleRef.current;
    const currentPageOffsets = pageOffsetsRef.current;
    const hadDrag = dragIntentRef.current && dragStartedRef.current;
    const hadResize = resizingRef.current;

    if (drawingRef.current && pdfId) {
      const docEl = viewerRef.current?.querySelector(
        "[data-viewer-document]",
      ) as HTMLElement | null;
      if (docEl) {
        const rect = docEl.getBoundingClientRect();
        const drawing = drawingRef.current;
        const sx0 = Math.min(drawing.startX, drawing.currentX) - rect.left;
        const sy0 = Math.min(drawing.startY, drawing.currentY) - rect.top;
        const sx1 = Math.max(drawing.startX, drawing.currentX) - rect.left;
        const sy1 = Math.max(drawing.startY, drawing.currentY) - rect.top;
        const pdfX0 = sx0 / currentScale;
        const pdfY0 = sy0 / currentScale;
        const pdfX1 = sx1 / currentScale;
        const pdfY1 = sy1 / currentScale;
        const centerY = (pdfY0 + pdfY1) / 2;
        let targetPage = 0;
        for (let i = 0; i < currentPageOffsets.length; i++) {
          if (
            i + 1 < currentPageOffsets.length &&
            centerY >= currentPageOffsets[i + 1]
          )
            continue;
          targetPage = i;
          break;
        }
        const pageY0 = pdfY0 - currentPageOffsets[targetPage];
        const pageY1 = pdfY1 - currentPageOffsets[targetPage];

        if (pdfX1 - pdfX0 > 5 && pdfY1 - pdfY0 > 5) {
          const counter = manualCounter + 1;
          setManualCounter(counter);
          const newId = `${pdfId}_ref_manual_${counter}`;
          const newBbox = {
            x0: pdfX0,
            y0: pageY0,
            x1: pdfX1,
            y1: pageY1,
            page: targetPage,
          };
          addRectangle(pdfId, {
            id: newId,
            pdf_id: pdfId,
            bbox: newBbox,
            text: "",
            ref_number: undefined,
            status: "edited",
          });
          const updated = useSourcesStore.getState().sourcesByPdf[pdfId] ?? [];
          const newSource = updated.find(
            (s) =>
              s.bbox.x0 === newBbox.x0 &&
              s.bbox.y0 === newBbox.y0 &&
              s.bbox.page === newBbox.page,
          );
          setSelectedSourceId(newSource?.id ?? null);
          saveSources(pdfId);
          if (newSource) extractAndSetText(pdfId, newSource.id, newBbox);
        }
      }
    }

    if (hadDrag && pdfId && dragIntentRef.current) {
      const draggedId = dragIntentRef.current.sourceId;
      void saveSources(pdfId).catch((e) => {
        console.error("Drag save failed:", e);
      });
      const currentSources =
        useSourcesStore.getState().sourcesByPdf[pdfId] ?? [];
      const movedSource = currentSources.find((s) => s.id === draggedId);
      if (movedSource)
        extractAndSetText(pdfId, draggedId, movedSource.bbox);
    }
    if (hadResize && pdfId) {
      void saveSources(pdfId).catch((e) => {
        console.error("Resize save failed:", e);
      });
      const currentSources =
        useSourcesStore.getState().sourcesByPdf[pdfId] ?? [];
      const resizedSource = currentSources.find(
        (s) => s.id === hadResize.sourceId,
      );
      if (resizedSource)
        extractAndSetText(pdfId, hadResize.sourceId, resizedSource.bbox);
    }

    dragIntentRef.current = null;
    dragStartedRef.current = false;
    resizingRef.current = null;
    drawingRef.current = null;
    setDrawingState(null);
  }, []);

  function onHandleMouseDown(
    e: React.MouseEvent,
    source: SourceRectangle,
    handle: string,
  ) {
    e.preventDefault();
    e.stopPropagation();
    suppressPageClickRef.current = true;
    if (!selectedPdfId) return;
    beginEdit(selectedPdfId);
    resizingRef.current = {
      sourceId: source.id,
      handle,
      startX: e.clientX,
      startY: e.clientY,
      origBbox: { ...source.bbox },
    };
  }

  function onDocumentContextMenu(e: React.MouseEvent) {
    e.preventDefault();
  }

  function onDocumentMouseDown(e: React.MouseEvent) {
    if (e.button !== 2) return;
    if (!selectedPdfId) return;
    suppressPageClickRef.current = true;
    const docEl = viewerRef.current?.querySelector(
      "[data-viewer-document]",
    ) as HTMLElement | null;
    if (!docEl) return;
    const rect = docEl.getBoundingClientRect();
    const relY = (e.clientY - rect.top) / scale;
    let targetPage = 0;
    for (let i = 0; i < pageOffsets.length; i++) {
      if (i + 1 < pageOffsets.length && relY >= pageOffsets[i + 1]) continue;
      targetPage = i;
      break;
    }
    const d = {
      page: targetPage,
      startX: e.clientX,
      startY: e.clientY,
      currentX: e.clientX,
      currentY: e.clientY,
    };
    drawingRef.current = d;
    setDrawingState(d);
  }

  function onPageClick() {
    if (suppressPageClickRef.current) {
      suppressPageClickRef.current = false;
      return;
    }
    setSelectedSourceId(null);
  }

  function drawPreviewStyle(): React.CSSProperties {
    if (!drawingState || !viewerRef.current) return { display: "none" };
    const viewerRect = viewerRef.current.getBoundingClientRect();
    const x0 =
      Math.min(drawingState.startX, drawingState.currentX) -
      viewerRect.left +
      viewerRef.current.scrollLeft;
    const y0 =
      Math.min(drawingState.startY, drawingState.currentY) -
      viewerRect.top +
      viewerRef.current.scrollTop;
    const w = Math.abs(drawingState.currentX - drawingState.startX);
    const h = Math.abs(drawingState.currentY - drawingState.startY);
    return { left: x0, top: y0, width: w, height: h };
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Delete" && selectedSourceId && selectedPdfId) {
      handleRemoveSource(selectedSourceId);
    }
    if (e.key === "z" && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
      e.preventDefault();
      handleRevert();
    }
    if (e.key === " " && selectedSourceId && selectedPdfId) {
      e.preventDefault();
      const pdfId = selectedPdfId;
      const newId = mergeWithClosest(pdfId, selectedSourceId);
      if (newId) {
        setSelectedSourceId(newId);
        void saveSources(pdfId).catch((err) => {
          console.error("Merge save failed:", err);
        });
      }
    }
  }

  const selectedSource = useMemo(
    () =>
      selectedSourceId
        ? (sources.find((s) => s.id === selectedSourceId) ?? null)
        : null,
    [sources, selectedSourceId],
  );
  const selectedSourceStatus = selectedSource?.status ?? null;

  // Fetch parsed fields when a source is selected (debounced 300ms, cached)
  useEffect(() => {
    if (!selectedSource || !selectedSource.text) {
      setParsedFields(null);
      return;
    }

    const sourceId = selectedSource.id;

    // Check cache
    if (parsedFieldsCache.current[sourceId]) {
      setParsedFields(parsedFieldsCache.current[sourceId]);
      return;
    }

    setParsedFieldsLoading(true);
    const timer = setTimeout(() => {
      api
        .extractFields(selectedSource.text)
        .then((result) => {
          parsedFieldsCache.current[sourceId] = result;
          setParsedFields(result);
        })
        .catch(() => {
          setParsedFields(null);
        })
        .finally(() => {
          setParsedFieldsLoading(false);
        });
    }, 300);

    return () => clearTimeout(timer);
  }, [selectedSource?.id, selectedSource?.text]);

  const HANDLES = ["n", "s", "w", "e", "nw", "ne", "sw", "se"] as const;

  return (
    <div
      className={styles["parsing-page"]}
      tabIndex={-1}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onKeyDown={onKeyDown}
    >
      {/* Left Panel: PDF List */}
      <aside className={styles["pdf-list-panel"]}>
        <div className={styles["panel-header"]}>
          <h2 className={styles["panel-title"]}>
            Documents
            {allPdfs.length > 0 && (
              <span className={styles["title-count"]}>
                {allPdfs.filter((p) => p.status === "approved").length} /{" "}
                {allPdfs.length}
              </span>
            )}
          </h2>
          <button
            className={styles["import-btn"]}
            onClick={handleImport}
            disabled={loading}
          >
            {loading ? (
              <>
                <span>&#x25CC;</span> Importing...
              </>
            ) : (
              "+ Import"
            )}
          </button>
        </div>

        {allPdfs.length > 0 && (
          <div className={styles["sort-bar"]}>
            <button
              className={`${styles["sort-btn"]} ${styles["sort-btn-status"]} ${sortKey === "status" ? styles["sort-active"] : ""}`}
              onClick={() => toggleSort("status")}
              title="Sort by status"
            >
              &#x25CF;
              {sortKey === "status" && (
                <span className={styles["sort-arrow"]}>
                  {sortAsc ? "\u2191" : "\u2193"}
                </span>
              )}
            </button>
            <button
              className={`${styles["sort-btn"]} ${styles["sort-btn-grow"]} ${sortKey === "name" ? styles["sort-active"] : ""}`}
              onClick={() => toggleSort("name")}
              title="Sort by name"
            >
              Name
              {sortKey === "name" && (
                <span className={styles["sort-arrow"]}>
                  {sortAsc ? "\u2191" : "\u2193"}
                </span>
              )}
            </button>
            <button
              className={`${styles["sort-btn"]} ${styles["sort-btn-numbered"]} ${sortKey === "numbered" ? styles["sort-active"] : ""}`}
              onClick={() => toggleSort("numbered")}
              title="Sort by numbered (unnumbered first)"
            >
              N
              {sortKey === "numbered" && (
                <span className={styles["sort-arrow"]}>
                  {sortAsc ? "\u2191" : "\u2193"}
                </span>
              )}
            </button>
            <button
              className={`${styles["sort-btn"]} ${styles["sort-btn-count"]} ${sortKey === "count" ? styles["sort-active"] : ""}`}
              onClick={() => toggleSort("count")}
              title="Sort by source count"
            >
              #
              {sortKey === "count" && (
                <span className={styles["sort-arrow"]}>
                  {sortAsc ? "\u2191" : "\u2193"}
                </span>
              )}
            </button>
          </div>
        )}

        <div className={styles["pdf-list"]}>
          {allPdfs.length === 0 ? (
            <div className={styles["empty-state"]}>
              <div className={styles["empty-icon"]}>&#x1F4C4;</div>
              <p>No PDFs imported yet</p>
              <p className={styles["empty-sub"]}>
                Click Import to select one or more PDF files
              </p>
            </div>
          ) : (
            sortedPdfs.map((pdf) => (
              <div key={pdf.id} className={styles["pdf-row"]}>
                <button
                  className={`${styles["pdf-item"]} ${selectedPdfId === pdf.id ? styles["pdf-selected"] : ""}`}
                  onClick={() => selectPdf(pdf.id)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    toggleApproval(pdf.id);
                  }}
                >
                  <span
                    className={`${styles["pdf-status"]} ${styles["pdf-status-removable"]}`}
                    title="Remove from list"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      handleRemovePdf(pdf.id);
                    }}
                  >
                    <span
                      className={styles["pdf-status-default"]}
                      style={{ color: statusColorStyle(pdf.status) }}
                    >
                      {statusIcon(pdf.status)}
                    </span>
                    <span className={styles["pdf-status-remove"]}>
                      &times;
                    </span>
                  </span>
                  <span className={styles["pdf-name"]} title={pdf.name}>
                    {pdf.name}
                  </span>
                  <span className={styles["pdf-numbered-col"]}>
                    {pdf.numbered && (
                      <span className={styles["numbered-tag"]}>N</span>
                    )}
                  </span>
                  <span className={styles["pdf-count"]}>{pdf.source_count}</span>
                </button>
              </div>
            ))
          )}
        </div>
      </aside>

      {/* Center Panel: PDF Viewer */}
      <section className={styles["viewer-panel"]}>
        {!selectedPdfId ? (
          <div className={styles["viewer-empty"]}>
            <div className={styles["viewer-empty-icon"]}>&#x25E7;</div>
            <p>Select a PDF to view</p>
          </div>
        ) : loadingPages ? (
          <div className={styles["viewer-empty"]}>
            <div className={styles["viewer-loading"]}>&#x25CC;</div>
            <p>Loading document...</p>
          </div>
        ) : pages.length > 0 ? (
          <>
            {/* Zoom toolbar */}
            <div className={styles["zoom-toolbar"]}>
              <div className={styles["toolbar-group-left"]}>
                <button
                  className={`${styles["zoom-btn"]} ${styles["zoom-text"]}`}
                  onClick={handleRevert}
                  disabled={!canRevertCurrent}
                  title="Undo"
                >
                  &#x21B6; Undo
                </button>
                <button
                  className={`${styles["zoom-btn"]} ${styles["zoom-text"]}`}
                  onClick={handleRevertToOriginal}
                  disabled={!sources.length}
                  title="Reset"
                >
                  &#x21BA; Reset
                </button>
              </div>

              <div className={styles["toolbar-group-center"]}>
                <div className={styles["zoom-controls"]}>
                  <button
                    className={`${styles["zoom-btn"]} ${styles["zoom-text"]}`}
                    onClick={zoomFit}
                    title="Fit to width"
                  >
                    Fit
                  </button>
                  <button
                    className={styles["zoom-btn"]}
                    onClick={zoomOut}
                    title="Zoom out"
                  >
                    -
                  </button>
                  <span className={styles["zoom-pct"]}>{zoomPercent}%</span>
                  <button
                    className={styles["zoom-btn"]}
                    onClick={zoomIn}
                    title="Zoom in"
                  >
                    +
                  </button>
                  <div className={styles["hints-trigger"]}>
                    <span className={styles["hints-icon"]}>i</span>
                    <div className={styles["hints-popup"]}>
                      <div className={styles["hint-row"]}>
                        <span className={styles["hint-keys"]}>Left click</span>
                        <span className={styles["hint-desc"]}>Select / Move</span>
                      </div>
                      <div className={styles["hint-row"]}>
                        <span className={styles["hint-keys"]}>Right hold</span>
                        <span className={styles["hint-desc"]}>Draw new</span>
                      </div>
                      <div className={styles["hint-row"]}>
                        <span className={styles["hint-keys"]}>Del</span>
                        <span className={styles["hint-desc"]}>Remove source</span>
                      </div>
                      <div className={styles["hint-row"]}>
                        <span className={styles["hint-keys"]}>Space</span>
                        <span className={styles["hint-desc"]}>Merge with closest</span>
                      </div>
                      <div className={styles["hint-row"]}>
                        <span className={styles["hint-keys"]}>Ctrl + Z</span>
                        <span className={styles["hint-desc"]}>Undo</span>
                      </div>
                      <div className={styles["hint-row"]}>
                        <span className={styles["hint-keys"]}>Ctrl + Scroll</span>
                        <span className={styles["hint-desc"]}>Zoom</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <div className={styles["toolbar-group-right"]}>
                <button
                  className={`${styles["zoom-btn"]} ${styles["zoom-text"]}`}
                  onClick={() =>
                    setActiveKind(activeNoteKind === null ? "highlight" : null)
                  }
                  style={
                    activeNoteKind !== null
                      ? { background: activeNoteColor }
                      : undefined
                  }
                  disabled={!pdfDoc}
                  title="Toggle notes mode"
                >
                  Notes{notes.length > 0 ? ` (${notes.length})` : ""}
                </button>
                <button
                  className={`${styles["toolbar-approve-btn"]} ${isApproved ? styles["toolbar-approved"] : ""}`}
                  onClick={handleApprove}
                  disabled={!sources.length}
                >
                  {isApproved ? "Approved" : "Approve"}
                </button>
              </div>
            </div>


            {/* Continuous document view */}
            <div
              className={styles["viewer-content"]}
              ref={viewerRef}
              data-scrollable
              role="button"
              tabIndex={0}
              aria-label="Document view"
              onClick={onPageClick}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  onPageClick();
                }
                // Space is handled by the parent onKeyDown:
                // - if a source is selected: merge with closest
                // - otherwise: do nothing (let parent handle clearing if needed)
              }}
            >
              <div
                data-viewer-document
                className={styles["viewer-document"]}
                style={{
                  width: maxPageWidth * scale,
                  height: totalHeight * scale,
                  margin: "0 auto",
                }}
                onContextMenu={onDocumentContextMenu}
                onMouseDown={onDocumentMouseDown}
              >
                {pages.map((page, idx) => (
                  <div key={page.page_num}>
                    {pdfDoc && (
                      <div
                        data-page-num={page.page_num}
                        style={{
                          position: "absolute",
                          top: pageOffsets[idx] * scale,
                          left: ((maxPageWidth - page.width) / 2) * scale,
                          width: page.width * scale,
                          height: page.height * scale,
                        }}
                      >
                        {visiblePageIndices.has(idx) && (
                          <PdfPageCanvas
                            doc={pdfDoc}
                            pageNum={page.page_num + 1}
                            zoom={scale}
                          />
                        )}
                        <NotesLayer
                          // Notes are only visible while in notes mode, so
                          // they aren't cluttered by (or visually collide
                          // with) the yellow source-rectangle overlays.
                          notes={
                            activeNoteKind !== null
                              ? notes.filter(
                                  (n) => n.pageNum === page.page_num,
                                )
                              : []
                          }
                          scale={scale}
                          activeKind={activeNoteKind}
                          activeColor={activeNoteColor}
                          pageWidth={page.width}
                          pageHeight={page.height}
                          onCreateCallout={(bbox) =>
                            handleCreateCallout(page.page_num, bbox)
                          }
                          onSelectNote={setSelectedNoteId}
                          selectedNoteId={selectedNoteId}
                        />
                      </div>
                    )}
                    {idx > 0 && (
                      <div
                        className={styles["page-boundary"]}
                        style={{
                          top: pageOffsets[idx] * scale,
                          width: maxPageWidth * scale,
                        }}
                      />
                    )}
                    {/* Source rectangles for this page — hidden while in
                        notes mode so they don't intercept text-selection
                        drags or callout draws. */}
                    {activeNoteKind === null &&
                      sourcesForPage(page.page_num).map((source) => (
                      <div
                        key={source.id}
                        className={`${styles["source-rect"]} ${selectedSourceId === source.id ? styles["source-selected"] : ""}`}
                        style={{
                          left: source.bbox.x0 * scale,
                          top: (pageOffsets[idx] + source.bbox.y0) * scale,
                          width: (source.bbox.x1 - source.bbox.x0) * scale,
                          height: (source.bbox.y1 - source.bbox.y0) * scale,
                        }}
                        title={source.text || "(no text)"}
                        onMouseDown={(e) => onRectMouseDown(e, source)}
                      >
                        <span className={styles["ref-label"]}>
                          {source.ref_number != null
                            ? `[${source.ref_number}]`
                            : "[+]"}
                        </span>
                        {selectedSourceId === source.id &&
                          HANDLES.map((h) => (
                            <div
                              key={h}
                              className={`${styles["resize-handle"]} ${styles[`rh-${h}`]}`}
                              onMouseDown={(e) =>
                                onHandleMouseDown(e, source, h)
                              }
                            />
                          ))}
                      </div>
                    ))}
                    {/* Multi-page continuation bboxes — also hidden in notes mode. */}
                    {activeNoteKind === null &&
                      extraBboxesForPage(page.page_num).map(
                        ({ source, bbox }) => (
                          <div
                            key={`${source.id}_page${bbox.page}`}
                            className={`${styles["source-rect"]} ${styles["source-rect-continuation"]} ${selectedSourceId === source.id ? styles["source-selected"] : ""}`}
                            style={{
                              left: bbox.x0 * scale,
                              top: (pageOffsets[idx] + bbox.y0) * scale,
                              width: (bbox.x1 - bbox.x0) * scale,
                              height: (bbox.y1 - bbox.y0) * scale,
                            }}
                            title={source.text || "(no text)"}
                            onMouseDown={(e) => onRectMouseDown(e, source)}
                          >
                            <span
                              className={`${styles["ref-label"]} ${styles["ref-label-cont"]}`}
                            >
                              {source.ref_number != null
                                ? `[${source.ref_number}]`
                                : "[+]"}{" "}
                              &#x21B5;
                            </span>
                          </div>
                        ),
                      )}
                  </div>
                ))}
              </div>

              {/* Draw preview rectangle */}
              {drawingState && (
                <div
                  className={styles["draw-preview"]}
                  style={drawPreviewStyle()}
                />
              )}
            </div>
          </>
        ) : (
          <div className={styles["viewer-empty"]}>
            <p>Unable to load document</p>
          </div>
        )}
      </section>

      {/* Right Panel: Actions & Source Detail (or Notes when notes mode is on) */}
      <aside className={styles["actions-panel"]}>
        {selectedPdf && activeNoteKind !== null ? (
          <>
            <div className={styles["panel-header"]}>
              <h2 className={styles["panel-title"]}>
                Notes{notes.length > 0 ? ` (${notes.length})` : ""}
              </h2>
            </div>

            <div
              className={styles["actions-content"]}
              style={{ display: "flex", flexDirection: "column", gap: 12, padding: 12 }}
            >
              {/* Tool toggles */}
              <div style={{ display: "flex", gap: 6 }}>
                <button
                  className={`${styles["zoom-btn"]} ${styles["zoom-text"]}`}
                  onClick={() => setActiveKind("highlight")}
                  style={{
                    flex: 1,
                    background:
                      activeNoteKind === "highlight" ? activeNoteColor : undefined,
                  }}
                  title="Highlight: select text to create"
                >
                  Highlight
                </button>
                <button
                  className={`${styles["zoom-btn"]} ${styles["zoom-text"]}`}
                  onClick={() => setActiveKind("callout")}
                  style={{
                    flex: 1,
                    background:
                      activeNoteKind === "callout" ? activeNoteColor : undefined,
                  }}
                  title="Callout: drag to draw a box"
                >
                  Callout
                </button>
              </div>

              {/* Color picker + preset swatches */}
              <div
                style={{
                  display: "flex",
                  gap: 6,
                  alignItems: "center",
                  flexWrap: "wrap",
                }}
              >
                <input
                  type="color"
                  value={activeNoteColor}
                  onChange={(e) => setActiveColor(e.target.value)}
                  title="Note color"
                  style={{
                    width: 32,
                    height: 24,
                    border: "1px solid #d4d4d8",
                    background: "transparent",
                    padding: 0,
                  }}
                />
                {["#fde68a", "#a7f3d0", "#bae6fd", "#fbcfe8", "#fed7aa"].map(
                  (swatch) => (
                    <button
                      key={swatch}
                      onClick={() => setActiveColor(swatch)}
                      title={swatch}
                      style={{
                        width: 20,
                        height: 20,
                        borderRadius: 3,
                        border:
                          activeNoteColor.toLowerCase() === swatch
                            ? "2px solid #111"
                            : "1px solid #d4d4d8",
                        background: swatch,
                        cursor: "pointer",
                      }}
                    />
                  ),
                )}
              </div>

              {/* Selected-note inline editor */}
              {selectedNote ? (
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 6,
                    padding: 8,
                    border: "1px solid #e4e4e7",
                    borderRadius: 4,
                  }}
                >
                  <span style={{ fontSize: 11, color: "#71717a" }}>
                    {selectedNote.kind === "callout" ? "Callout" : "Highlight"}{" "}
                    · Page {selectedNote.pageNum + 1}
                  </span>
                  <textarea
                    value={selectedNote.text}
                    onChange={(e) =>
                      handleUpdateSelectedNoteText(e.target.value)
                    }
                    placeholder={
                      selectedNote.kind === "callout"
                        ? "Callout text (Enter for new line)…"
                        : "Optional comment…"
                    }
                    autoFocus
                    rows={4}
                    style={{
                      padding: "4px 8px",
                      border: "1px solid #d4d4d8",
                      borderRadius: 4,
                      fontSize: 12,
                      resize: "vertical",
                      fontFamily: "inherit",
                      whiteSpace: "pre-wrap",
                    }}
                  />
                  {selectedNote.kind === "callout" && selectedPdfId && (
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        fontSize: 11,
                      }}
                    >
                      <label
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 4,
                          color: "#71717a",
                        }}
                      >
                        Size
                        <input
                          type="number"
                          min={CALLOUT_FONT_SIZE_MIN}
                          max={CALLOUT_FONT_SIZE_MAX}
                          value={
                            selectedNote.fontSize ?? DEFAULT_CALLOUT_FONT_SIZE
                          }
                          onChange={(e) => {
                            const next = Math.max(
                              CALLOUT_FONT_SIZE_MIN,
                              Math.min(
                                CALLOUT_FONT_SIZE_MAX,
                                Number(e.target.value) ||
                                  DEFAULT_CALLOUT_FONT_SIZE,
                              ),
                            );
                            updateNote(selectedPdfId, selectedNote.id, {
                              fontSize: next,
                            });
                          }}
                          style={{
                            width: 48,
                            padding: "2px 4px",
                            border: "1px solid #d4d4d8",
                            borderRadius: 4,
                            fontSize: 12,
                          }}
                        />
                      </label>
                      <button
                        onClick={() =>
                          updateNote(selectedPdfId, selectedNote.id, {
                            bold: !selectedNote.bold,
                          })
                        }
                        title="Toggle bold"
                        style={{
                          padding: "2px 8px",
                          border: "1px solid #d4d4d8",
                          borderRadius: 4,
                          background: selectedNote.bold ? "#1f2937" : "#fff",
                          color: selectedNote.bold ? "#fff" : "#111",
                          fontWeight: 700,
                          cursor: "pointer",
                        }}
                      >
                        B
                      </button>
                    </div>
                  )}
                  <button
                    className={`${styles["zoom-btn"]} ${styles["zoom-text"]}`}
                    onClick={handleDeleteSelectedNote}
                  >
                    Delete note
                  </button>
                </div>
              ) : (
                <span style={{ color: "#a8a29e", fontSize: 12 }}>
                  {activeNoteKind === "highlight"
                    ? "Select text to highlight."
                    : "Drag a box to place a callout."}
                </span>
              )}

              {/* Export */}
              <button
                className={`${styles["zoom-btn"]} ${styles["zoom-text"]}`}
                onClick={handleExportAnnotatedPdf}
                disabled={exportingPdf || notes.length === 0 || !pdfDoc}
                title="Save a copy of the PDF with notes baked in"
                style={{ marginTop: "auto" }}
              >
                {exportingPdf ? "Exporting…" : "Export PDF"}
              </button>
            </div>
          </>
        ) : selectedPdf ? (
          <>
            <div className={styles["panel-header"]}>
              <div className={styles["source-detail-heading"]}>
                <h2 className={styles["panel-title"]}>Source Detail</h2>
                {selectedSourceStatus && (
                  <div className={styles["source-status-tags"]}>
                    <span
                      className={`${styles["source-status-tag"]} ${styles["source-status-tag-active"]}`}
                    >
                      {selectedSourceStatus}
                    </span>
                  </div>
                )}
              </div>
            </div>

            <div className={styles["actions-content"]}>
              {selectedSource && (
                <div className={styles["source-detail"]}>
                  <div className={styles["detail-meta-row"]}>
                    <div className={styles["detail-meta-group"]}>
                      <span className={styles["detail-label"]}>Ref #</span>
                      <span className={styles["detail-value"]}>
                        {selectedSource.ref_number != null
                          ? selectedSource.ref_number
                          : "-"}
                      </span>
                    </div>
                    <div className={styles["detail-meta-group"]}>
                      <span className={styles["detail-label"]}>Page</span>
                      <span className={styles["detail-value"]}>
                        {selectedSource.bbox.page + 1}
                      </span>
                    </div>
                    <button
                      className={styles["detail-remove-icon"]}
                      onClick={() => handleRemoveSource(selectedSource.id)}
                      title="Remove source"
                      aria-label="Remove source"
                    >
                      &#x2715;
                    </button>
                  </div>

                  {/* Extracted fields */}
                  {parsedFieldsLoading && (
                    <div className={styles["fields-loading"]}>Extracting fields...</div>
                  )}
                  {parsedFields && !parsedFieldsLoading && (
                    <div className={styles["parsed-fields"]}>
                      {parsedFields.title && (
                        <div className={styles["field-row"]}>
                          <span className={styles["field-label"]}>Title</span>
                          <span className={styles["field-value"]}>{parsedFields.title}</span>
                        </div>
                      )}
                      {parsedFields.authors.length > 0 && (
                        <div className={styles["field-row"]}>
                          <span className={styles["field-label"]}>Authors</span>
                          <span className={styles["field-value"]}>
                            {parsedFields.authors.join(", ")}
                          </span>
                        </div>
                      )}
                      {parsedFields.year && (
                        <div className={styles["field-row"]}>
                          <span className={styles["field-label"]}>Year</span>
                          <span className={styles["field-value"]}>{parsedFields.year}</span>
                        </div>
                      )}
                      {parsedFields.source && (
                        <div className={styles["field-row"]}>
                          <span className={styles["field-label"]}>Source</span>
                          <span className={styles["field-value"]}>{parsedFields.source}</span>
                        </div>
                      )}
                      {parsedFields.url && (
                        <div className={styles["field-row"]}>
                          <span className={styles["field-label"]}>URL</span>
                          <a
                            className={styles["field-link"]}
                            href={parsedFields.url}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {parsedFields.url.length > 50
                              ? parsedFields.url.slice(0, 50) + "..."
                              : parsedFields.url}
                          </a>
                        </div>
                      )}
                      <div className={styles["field-row"]}>
                        <span className={styles["field-label"]}>Method</span>
                        <span className={styles["extraction-method-badge"]}>
                          {parsedFields.extraction_method.toUpperCase()}
                        </span>
                        <span className={styles["confidence-value"]}>
                          {Math.round(parsedFields.parse_confidence * 100)}%
                        </span>
                      </div>
                    </div>
                  )}

                  {/* Collapsible raw text */}
                  <div className={styles["raw-text-section"]}>
                    <button
                      className={styles["raw-text-toggle"]}
                      onClick={() => setRawTextExpanded((v) => !v)}
                    >
                      <span className={styles["raw-text-toggle-icon"]}>
                        {rawTextExpanded ? "\u25BC" : "\u25B6"}
                      </span>
                      Raw Text
                    </button>
                    {rawTextExpanded && (
                      <div className={styles["detail-text-display"]}>
                        {selectedSource.text || "(no text detected)"}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {!selectedSource && (
                <div className={styles["actions-empty"]}>
                  <p className={styles["actions-empty-text"]}>
                    Select a source box to see details
                  </p>
                </div>
              )}
            </div>
          </>
        ) : (
          <div className={styles["actions-empty"]}>
            <p className={styles["actions-empty-text"]}>
              Select a document to see actions
            </p>
          </div>
        )}
      </aside>
    </div>
  );
}
