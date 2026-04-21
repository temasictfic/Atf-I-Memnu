import {
  useState,
  useMemo,
  useEffect,
  useLayoutEffect,
  useRef,
  useCallback,
} from "react";
import { useTranslation } from "react-i18next";
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
  mergeWithPrevious,
} from "../../stores/sources-store";
import {
  clearVerificationForPdf,
  useVerificationStore,
} from "../../stores/verification-store";
import type { SourceRectangle, PageData, ParsedSource } from "../../api/types";
import { api } from "../../api/rest-client";
import { extractTextInBbox } from "../../pdf/extract-text";
import { getOrLoadDocument } from "../../pdf/document-cache";
import {
  addNote,
  beginNoteEdit,
  getNotes,
  removeNote,
  resetNotes,
  revertNotes,
  setActiveColor,
  setActiveKind,
  setCalloutBold,
  setCalloutFontSize,
  setCalloutOpacity,
  setCalloutTextColor,
  updateNote,
  useNotesStore,
  DEFAULT_CALLOUT_FONT_SIZE,
  CALLOUT_FONT_SIZE_MIN,
  CALLOUT_FONT_SIZE_MAX,
} from "../../stores/notes-store";
import { generateAutoNotesForPdf } from "../../notes/auto-notes";
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
  const { t } = useTranslation();
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
  const calloutOpacity = useNotesStore((s) => s.calloutOpacity);
  const calloutTextColor = useNotesStore((s) => s.calloutTextColor);
  const calloutDefaultFontSize = useNotesStore((s) => s.calloutFontSize);
  const calloutDefaultBold = useNotesStore((s) => s.calloutBold);
  const notes = useMemo(
    () => (selectedPdfId ? (notesByPdf[selectedPdfId] ?? []) : []),
    [notesByPdf, selectedPdfId],
  );
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  // Bumped every time the user clicks a note (even re-clicks the same one),
  // so the focus effect below re-runs and returns focus to the text editor.
  const [noteFocusNonce, setNoteFocusNonce] = useState(0);
  const [exportingPdf, setExportingPdf] = useState(false);
  // Transient success flag — set for ~1.8 s after a successful export so
  // the Export PDF button can pulse a confirmation.
  const [exportSuccess, setExportSuccess] = useState(false);
  const noteEditorRef = useRef<HTMLTextAreaElement | null>(null);

  const handleSelectNote = useCallback((id: string) => {
    setSelectedNoteId(id);
    setNoteFocusNonce((n) => n + 1);
    // Switch the right-panel tool to match the clicked note's kind so
    // the "Highlight" / "Callout" sub-tabs, the default color, and the
    // callout-only controls all reflect what the user just selected.
    const s = useNotesStore.getState();
    const pdfId = usePdfStore.getState().selectedPdfId;
    if (!pdfId) return;
    const note = s.notesByPdf[pdfId]?.find((n) => n.id === id);
    if (!note) return;
    if (s.activeKind !== note.kind) {
      setActiveKind(note.kind);
    }
  }, []);

  // Focus the callout text editor whenever a callout becomes selected (or
  // the user re-clicks the same one). Highlights have no text editor, so
  // they never steal focus. The textarea doesn't exist until after the
  // next render, so the effect runs in post-commit.
  useEffect(() => {
    if (!selectedNoteId) return;
    const note = notesByPdf[selectedPdfId ?? ""]?.find(
      (n) => n.id === selectedNoteId,
    );
    if (note?.kind !== "callout") return;
    noteEditorRef.current?.focus();
  }, [noteFocusNonce, selectedNoteId, notesByPdf, selectedPdfId]);

  // Document-level Delete handler for notes. Runs in the capture phase
  // so we intercept the key *before* the callout textarea performs its
  // forward-delete on a character, and call preventDefault. Only armed
  // while Notes mode is active so it doesn't hijack Delete elsewhere.
  //
  // Del = remove the selected note entirely, even while typing in the
  // callout text editor. Backspace is not intercepted, so it keeps
  // working as a per-character delete inside the textarea.
  useEffect(() => {
    if (!selectedPdfId || !selectedNoteId || activeNoteKind === null) return;
    const onDocKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Delete") return;
      e.preventDefault();
      beginNoteEdit(selectedPdfId);
      removeNote(selectedPdfId, selectedNoteId);
      setSelectedNoteId(null);
    };
    document.addEventListener("keydown", onDocKeyDown, true);
    return () =>
      document.removeEventListener("keydown", onDocKeyDown, true);
  }, [selectedPdfId, selectedNoteId, activeNoteKind]);

  // Blur the note text editor when the user clicks anywhere that isn't
  // the note's own element or the editor itself. Runs in the capture
  // phase so React handlers calling stopPropagation on mousedown (e.g.
  // NotesLayer draw/drag gestures) can't suppress it. The click still
  // bubbles through normal handlers, which re-select the note and the
  // focus-on-select effect above refocuses the textarea.
  useEffect(() => {
    if (!selectedNoteId) return;
    const onDocMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const editor = noteEditorRef.current;
      if (editor && editor.contains(target)) return;
      // Data-attribute set on the rendered note element in NotesLayer.
      if (target.closest(`[data-note-id="${selectedNoteId}"]`)) return;
      if (editor && document.activeElement === editor) editor.blur();
    };
    document.addEventListener("mousedown", onDocMouseDown, true);
    return () =>
      document.removeEventListener("mousedown", onDocMouseDown, true);
  }, [selectedNoteId]);

  const selectedPdf = useMemo(
    () => allPdfs.find((p) => p.id === selectedPdfId),
    [allPdfs, selectedPdfId],
  );
  const sources = useMemo(
    () => (selectedPdfId ? (sourcesByPdf[selectedPdfId] ?? []) : []),
    [sourcesByPdf, selectedPdfId],
  );
  const notesHistoryByPdf = useNotesStore((s) => s.notesHistoryByPdf);
  const canRevertSources = useMemo(() => {
    if (!selectedPdfId) return false;
    const h = historyByPdf[selectedPdfId];
    return h ? h.length > 0 : false;
  }, [historyByPdf, selectedPdfId]);
  const canRevertNotesForCurrent = useMemo(() => {
    if (!selectedPdfId) return false;
    const h = notesHistoryByPdf[selectedPdfId];
    return h ? h.length > 0 : false;
  }, [notesHistoryByPdf, selectedPdfId]);
  // Which history the Undo/Reset buttons act on depends on the active
  // right-panel tab: Notes mode → notes history, Source Detail → sources.
  const canRevertCurrent =
    activeNoteKind !== null ? canRevertNotesForCurrent : canRevertSources;
  const canResetCurrent =
    activeNoteKind !== null
      ? (selectedPdfId ? (notesByPdf[selectedPdfId]?.length ?? 0) > 0 : false)
      : sources.length > 0;
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
  // Keyed by the raw source text, NOT the source ID. When the user edits a
  // rectangle (draws, moves, resizes, manually re-extracts) the text
  // changes, so keying by text means edits naturally miss the cache and
  // we re-run NER extraction. Re-selecting the same source still hits.
  const parsedFieldsCache = useRef<Record<string, ParsedSource>>({});
  const [rawTextExpanded, setRawTextExpanded] = useState(true);

  // Refs for interaction state (not reactive, no re-render needed)
  const viewerRef = useRef<HTMLDivElement>(null);
  const loadedPdfIdRef = useRef<string | null>(null);
  // Monotonic counter bumped on every `loadPdfPages` call. Each load captures
  // its own generation at entry and re-checks after every `await`; if the
  // ref moves ahead, a newer load has started and the older one must abort
  // and destroy any pdfjs-dist objects it's already created. Without this,
  // rapid PDF switches leak PDFDocumentProxy instances into the pdfjs worker.
  const loadGenerationRef = useRef(0);
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

  // On unmount we just drop our reference — the doc itself is owned by
  // document-cache.ts, which manages its lifetime via the LRU. Destroying
  // it here would evict a potentially-cached doc out from under the cache.
  useEffect(() => {
    return () => {
      setPdfDoc(null);
    };
  }, []);

  async function loadPdfPages(pdfId: string) {
    const myGen = ++loadGenerationRef.current;
    const isStale = () => loadGenerationRef.current !== myGen;

    setLoadingPages(true);
    setSelectedSourceId(null);
    // NOTE: we do NOT clear pdfDoc/pages here. Leaving the previous view
    // mounted avoids a blank-flash on switch and lets React.memo preserve
    // unrelated children. When the new doc is ready we swap in a single
    // state update below.
    try {
      const localPath = pdfPathsById[pdfId];
      if (!localPath) {
        console.warn(
          `[ParsingPage] no local path for ${pdfId}; cannot render`,
        );
        if (!isStale()) {
          setPages([]);
          setPdfDoc(null);
        }
        return;
      }

      // Pull the doc from the LRU cache — on a cache hit this resolves
      // synchronously from memory with no IPC / no worker round-trip, so
      // switching between recently-viewed PDFs feels instant. On a miss
      // it reads the file, parses, and probes first+last page dimensions
      // in parallel with the pdfjs worker.
      const entry = await getOrLoadDocument(localPath);

      // Guard against rapid PDF switches — if a newer load has started, or
      // the store has moved to a different PDF entirely, leave the cached
      // entry alone (the cache owns its lifetime) and bail.
      if (isStale() || usePdfStore.getState().selectedPdfId !== pdfId) {
        return;
      }

      // Uniform-page fast path. If the first and last pages match (the
      // common case for academic papers), every page uses the first-page
      // dimensions. If they differ, we set the last page to its actual
      // size and leave the interior pages at the first-page size — a
      // minor layout inaccuracy only visible for genuinely non-uniform
      // documents, which this app rarely encounters.
      const pageDataList: PageData[] = Array.from(
        { length: entry.numPages },
        (_, i) => ({
          page_num: i,
          width: entry.firstPageWidth,
          height: entry.firstPageHeight,
        }),
      );
      if (entry.lastPageDimensions && entry.numPages > 1) {
        pageDataList[entry.numPages - 1] = {
          page_num: entry.numPages - 1,
          width: entry.lastPageDimensions.width,
          height: entry.lastPageDimensions.height,
        };
      }

      // Mark this load as needing an initial fit; the useLayoutEffect below
      // picks it up after React commits the new pages to the DOM and applies
      // the fit-to-width scale before the browser paints — so there is no
      // visible "100% then fit" jump when switching PDFs.
      pendingFitRef.current = true;
      setPages(pageDataList);
      setPdfDoc(entry.doc);

      // Sources: the orchestrator has already populated the local store on
      // import, but if the user opens a PDF that was imported in a prior
      // session the store may be empty — fall back to the cache endpoint
      // in that case. This mirrors the old `getSources` seeding.
      if (!isStale() && !useSourcesStore.getState().sourcesByPdf[pdfId]) {
        await loadSources(pdfId);
      }
    } catch (e) {
      console.error("Failed to load PDF pages:", e);
      if (!isStale()) {
        setPages([]);
        setPdfDoc(null);
        // Surface the error to the user instead of a silent blank viewer.
        window.alert(
          `Failed to open PDF: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    } finally {
      if (!isStale()) setLoadingPages(false);
    }
  }

  async function handleImport() {
    try {
      const files = await window.electronAPI.selectPdfs();
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

    clearSourcesForPdf(pdfId);
    clearVerificationForPdf(pdfId);
    removePdf(pdfId);
  }

  async function handleApprove() {
    if (!selectedPdfId) return;
    await toggleApproval(selectedPdfId);
  }

  async function handleToggleAllApproval() {
    const pdfs = usePdfStore
      .getState()
      .pdfs.filter((p) => p.status !== "pending" && p.status !== "parsing");
    if (pdfs.length === 0) return;
    // If every eligible PDF is already approved, unapprove them all.
    // Otherwise approve every eligible PDF that isn't already approved.
    const allApproved = pdfs.every((p) => p.status === "approved");
    const targets = allApproved
      ? pdfs
      : pdfs.filter((p) => p.status !== "approved");
    // Run sequentially — toggleApproval writes to the sources store per PDF,
    // and parallel execution could race on the save endpoint.
    for (const pdf of targets) {
      try {
        await toggleApproval(pdf.id);
      } catch (err) {
        console.error(`Failed to toggle approval for ${pdf.id}:`, err);
      }
    }
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
    // In Notes mode Undo pops the notes-history stack; otherwise it undoes
    // the last source-rectangle edit (and triggers a save).
    if (activeNoteKind !== null) {
      revertNotes(pdfId);
      setSelectedNoteId(null);
      return;
    }
    revert(pdfId);
    void saveSources(pdfId).catch((err) => {
      console.error("Undo save failed:", err);
    });
  }

  async function handleRevertToOriginal() {
    if (!selectedPdfId) return;
    // Reset in Notes mode clears every note for the PDF (undoable via
    // Undo); otherwise falls back to the sources "revert to original".
    if (activeNoteKind !== null) {
      resetNotes(selectedPdfId);
      setSelectedNoteId(null);
      return;
    }
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

  // Shared handler for the main color picker + preset swatches: updates
  // the persisted per-kind default AND, when a note is selected, that
  // note's own color (snapshotting history first so Undo reverts both).
  function applyColorChoice(color: string) {
    setActiveColor(color);
    if (
      selectedPdfId &&
      selectedNote &&
      ((activeNoteKind === "highlight" && selectedNote.kind === "highlight") ||
        (activeNoteKind === "callout" && selectedNote.kind === "callout"))
    ) {
      beginNoteEdit(selectedPdfId);
      updateNote(selectedPdfId, selectedNote.id, { color });
    }
  }

  function handleCreateHighlight(
    pageNum: number,
    bbox: { x0: number; y0: number; x1: number; y1: number },
  ) {
    if (!selectedPdfId) return;
    beginNoteEdit(selectedPdfId);
    const s = useNotesStore.getState();
    const note = addNote({
      pdfId: selectedPdfId,
      pageNum,
      kind: "highlight",
      bbox,
      text: "",
      color: s.highlightColor,
    });
    setSelectedNoteId(note.id);
  }

  function handleCreateCallout(
    pageNum: number,
    bbox: { x0: number; y0: number; x1: number; y1: number },
  ) {
    if (!selectedPdfId) return;
    beginNoteEdit(selectedPdfId);
    // Seed the callout with the user's persisted defaults (color, text
    // color, size, bold). The text starts empty — selecting the note
    // focuses the inline editor.
    const s = useNotesStore.getState();
    const note = addNote({
      pdfId: selectedPdfId,
      pageNum,
      kind: "callout",
      bbox,
      text: "",
      color: s.calloutColor,
      textColor: s.calloutTextColor,
      fontSize: s.calloutFontSize,
      bold: s.calloutBold,
    });
    setSelectedNoteId(note.id);
  }

  async function handleAutoAnnotate() {
    if (!selectedPdfId) return;
    beginNoteEdit(selectedPdfId);
    const results =
      useVerificationStore.getState().resultsByPdf[selectedPdfId] ?? {};
    const stats = await generateAutoNotesForPdf({
      pdfId: selectedPdfId,
      pdfName: selectedPdf?.name ?? selectedPdfId,
      sources,
      resultsBySourceId: results,
      pageHeightFor: (pageNum) => pages[pageNum]?.height ?? 0,
      pageWidthFor: (pageNum) => pages[pageNum]?.width ?? 0,
    });
    if (stats.highlightsAdded === 0 && stats.calloutsAdded === 0) {
      window.alert(
        "No non-Found references to annotate.",
      );
    }
  }

  function handleDeleteSelectedNote() {
    if (!selectedPdfId || !selectedNoteId) return;
    beginNoteEdit(selectedPdfId);
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
      // Lazy-load pdf-lib + fontkit (~1.2 MB) only on first export.
      const { writeNotesToPdf } = await import("../../pdf/annotation-writer");
      const annotated = await writeNotesToPdf(bytes, pdfNotes, {
        calloutOpacity: useNotesStore.getState().calloutOpacity,
      });
      await window.electronAPI.writePdfFile(target, annotated);
      // Flash a success state on the Export button for ~1.8 s.
      setExportSuccess(true);
      window.setTimeout(() => setExportSuccess(false), 1800);
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
    // Don't hijack keys while the user is typing in a text field
    // (e.g. the callout text editor or source detail inputs).
    const target = e.target as HTMLElement | null;
    const isEditable =
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      (target?.isContentEditable ?? false);

    if (e.key === "Delete" && !isEditable && selectedSourceId && selectedPdfId) {
      handleRemoveSource(selectedSourceId);
    }
    if (e.key === "z" && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
      e.preventDefault();
      handleRevert();
    }
    if (e.key === " " && selectedSourceId && selectedPdfId) {
      e.preventDefault();
      const pdfId = selectedPdfId;
      const newId = mergeWithPrevious(pdfId, selectedSourceId);
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
    const text = selectedSource?.text;
    if (!selectedSource || !text) {
      setParsedFields(null);
      return;
    }

    // Check cache by text — edits to a rectangle change the text, so a
    // stale cached result can never shadow fresh text.
    const cached = parsedFieldsCache.current[text];
    if (cached) {
      setParsedFields(cached);
      setParsedFieldsLoading(false);
      return;
    }

    setParsedFieldsLoading(true);
    const timer = setTimeout(() => {
      api
        .extractFields(text)
        .then((result) => {
          parsedFieldsCache.current[text] = result;
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
            {t("parsing.documents")}
          </h2>
          <button
            className={styles["import-btn"]}
            onClick={handleImport}
            disabled={loading}
            title={t("parsing.import")}
            aria-label={t("parsing.import")}
          >
            {loading ? <span>&#x25CC;</span> : <span>+</span>}
          </button>
          {allPdfs.length > 0 && (() => {
            const eligible = allPdfs.filter(
              (p) => p.status !== "pending" && p.status !== "parsing",
            );
            const approvedCount = allPdfs.filter(
              (p) => p.status === "approved",
            ).length;
            const allEligibleApproved =
              eligible.length > 0 &&
              eligible.every((p) => p.status === "approved");
            return (
              <button
                type="button"
                className={styles["approve-all-btn"]}
                disabled={eligible.length === 0}
                onClick={() => {
                  if (eligible.length === 0) return;
                  void handleToggleAllApproval();
                }}
                title={
                  eligible.length === 0
                    ? t("parsing.noPdfsReadyToApprove")
                    : allEligibleApproved
                      ? t("parsing.unapproveAll")
                      : t("parsing.approveAll")
                }
              >
                {approvedCount} / {allPdfs.length}
              </button>
            );
          })()}
        </div>

        {allPdfs.length > 0 && (
          <div className={styles["sort-bar"]}>
            <button
              className={`${styles["sort-btn"]} ${styles["sort-btn-status"]} ${sortKey === "status" ? styles["sort-active"] : ""}`}
              onClick={() => toggleSort("status")}
              title={t("parsing.sort.byStatus")}
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
              title={t("parsing.sort.byName")}
            >
              {t("parsing.sort.name")}
              {sortKey === "name" && (
                <span className={styles["sort-arrow"]}>
                  {sortAsc ? "\u2191" : "\u2193"}
                </span>
              )}
            </button>
            <button
              className={`${styles["sort-btn"]} ${styles["sort-btn-numbered"]} ${sortKey === "numbered" ? styles["sort-active"] : ""}`}
              onClick={() => toggleSort("numbered")}
              title={t("parsing.sort.byNumbered")}
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
              title={t("parsing.sort.byCount")}
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
              <p>{t("parsing.noPdfsImported")}</p>
              <p className={styles["empty-sub"]}>
                {t("parsing.emptyStateSub")}
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
                    title={t("parsing.removeFromList")}
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
            <p>{t("parsing.selectPdfToView")}</p>
          </div>
        ) : loadingPages ? (
          <div className={styles["viewer-empty"]}>
            <div className={styles["viewer-loading"]}>&#x25CC;</div>
            <p>{t("parsing.loadingDocument")}</p>
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
                  title={t("parsing.undo")}
                >
                  &#x21B6; {t("parsing.undo")}
                </button>
                <button
                  className={`${styles["zoom-btn"]} ${styles["zoom-text"]}`}
                  onClick={handleRevertToOriginal}
                  disabled={!canResetCurrent}
                  title={
                    activeNoteKind !== null
                      ? t("parsing.resetAllNotes")
                      : t("parsing.reset")
                  }
                >
                  &#x21BA; {t("parsing.reset")}
                </button>
              </div>

              <div className={styles["toolbar-group-center"]}>
                <div className={styles["zoom-controls"]}>
                  <button
                    className={styles["zoom-btn"]}
                    onClick={zoomOut}
                    title={t("parsing.zoomOut")}
                  >
                    -
                  </button>
                  <button
                    className={`${styles["zoom-btn"]} ${styles["zoom-pct"]}`}
                    onClick={zoomFit}
                    title={t("parsing.fitToWidth")}
                    aria-label={t("parsing.fitToWidth")}
                  >
                    {zoomPercent}%
                  </button>
                  <button
                    className={styles["zoom-btn"]}
                    onClick={zoomIn}
                    title={t("parsing.zoomIn")}
                  >
                    +
                  </button>
                </div>
              </div>

              <div className={styles["toolbar-group-right"]}>
                <div className={styles["hints-trigger"]}>
                  <span className={styles["hints-icon"]}>i</span>
                  <div className={styles["hints-popup"]}>
                    <div className={styles["hint-row"]}>
                      <span className={styles["hint-keys"]}>{t("parsing.hints.leftClick")}</span>
                      <span className={styles["hint-desc"]}>{t("parsing.hints.selectMove")}</span>
                    </div>
                    <div className={styles["hint-row"]}>
                      <span className={styles["hint-keys"]}>{t("parsing.hints.rightHold")}</span>
                      <span className={styles["hint-desc"]}>{t("parsing.hints.drawNew")}</span>
                    </div>
                    <div className={styles["hint-row"]}>
                      <span className={styles["hint-keys"]}>{t("parsing.hints.del")}</span>
                      <span className={styles["hint-desc"]}>{t("parsing.hints.removeSource")}</span>
                    </div>
                    <div className={styles["hint-row"]}>
                      <span className={styles["hint-keys"]}>{t("parsing.hints.space")}</span>
                      <span className={styles["hint-desc"]}>{t("parsing.hints.mergePrevious")}</span>
                    </div>
                    <div className={styles["hint-row"]}>
                      <span className={styles["hint-keys"]}>{t("parsing.hints.ctrlZ")}</span>
                      <span className={styles["hint-desc"]}>{t("parsing.hints.undo")}</span>
                    </div>
                    <div className={styles["hint-row"]}>
                      <span className={styles["hint-keys"]}>{t("parsing.hints.ctrlScroll")}</span>
                      <span className={styles["hint-desc"]}>{t("parsing.hints.zoom")}</span>
                    </div>
                  </div>
                </div>
                <button
                  className={`${styles["toolbar-approve-btn"]} ${isApproved ? styles["toolbar-approved"] : ""}`}
                  onClick={handleApprove}
                  disabled={!sources.length}
                >
                  {isApproved ? t("parsing.approved") : t("parsing.approve")}
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
              aria-label={t("parsing.documentView")}
              onClick={onPageClick}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  onPageClick();
                }
                // Space is handled by the parent onKeyDown
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
                          onCreateHighlight={(bbox) =>
                            handleCreateHighlight(page.page_num, bbox)
                          }
                          onSelectNote={handleSelectNote}
                          selectedNoteId={selectedNoteId}
                          onUpdateNoteBbox={(noteId, bbox) => {
                            if (!selectedPdfId) return;
                            updateNote(selectedPdfId, noteId, { bbox });
                          }}
                          onMoveNoteToPage={(noteId, pageNum, bbox) => {
                            if (!selectedPdfId) return;
                            updateNote(selectedPdfId, noteId, {
                              pageNum,
                              bbox,
                            });
                          }}
                          onBeginNoteEdit={() => {
                            if (selectedPdfId) beginNoteEdit(selectedPdfId);
                          }}
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
                        title={source.text || t("parsing.noText")}
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
                            title={source.text || t("parsing.noText")}
                            onMouseDown={(e) => onRectMouseDown(e, source)}
                          />
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
            <p>{t("parsing.unableToLoad")}</p>
          </div>
        )}
      </section>

      {/* Right Panel: Actions & Source Detail (or Notes when notes mode is on) */}
      <aside className={styles["actions-panel"]}>
        {selectedPdf && activeNoteKind !== null ? (
          <>
            <div className={styles["panel-header"]}>
              <div className={styles["source-detail-heading"]}>
                <div className={styles["panel-tabs"]}>
                  <button
                    type="button"
                    className={`${styles["panel-tab"]}`}
                    onClick={() => setActiveKind(null)}
                    title={t("parsing.showSourceDetail")}
                  >
                    {t("parsing.sourceDetail")}
                  </button>
                  <span className={styles["panel-tab-sep"]}>|</span>
                  <button
                    type="button"
                    className={`${styles["panel-tab"]} ${styles["panel-tab-active"]}`}
                    onClick={() => setActiveKind("highlight")}
                    title={t("parsing.showNotes")}
                  >
                    {t("parsing.notesTab")}{notes.length > 0 ? ` (${notes.length})` : ""}
                  </button>
                </div>
              </div>
            </div>

            <div
              className={styles["actions-content"]}
              style={{ display: "flex", flexDirection: "column", gap: 12, padding: 16 }}
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
                  title={t("parsing.highlightTool")}
                >
                  {t("parsing.highlight")}
                </button>
                <button
                  className={`${styles["zoom-btn"]} ${styles["zoom-text"]}`}
                  onClick={() => setActiveKind("callout")}
                  style={{
                    flex: 1,
                    background:
                      activeNoteKind === "callout" ? activeNoteColor : undefined,
                  }}
                  title={t("parsing.calloutTool")}
                >
                  {t("parsing.callout")}
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
                  onChange={(e) => applyColorChoice(e.target.value)}
                  title={t("parsing.noteColor")}
                  style={{
                    width: 24,
                    height: 20,
                    border: "1px solid #d4d4d8",
                    background: "transparent",
                    padding: 0,
                    boxSizing: "border-box",
                  }}
                />
                {[
                  "#fde68a",
                  "#a7f3d0",
                  "#bae6fd",
                  "#fbcfe8",
                  "#fed7aa",
                  "#ddd6fe",
                  "#fecaca",
                ].map(
                  (swatch) => (
                    <button
                      key={swatch}
                      onClick={() => applyColorChoice(swatch)}
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
                        boxSizing: "border-box",
                      }}
                    />
                  ),
                )}
              </div>

              {/* Callout background opacity — applies to every callout
                  (manual + auto-generated) in the overlay and in the
                  exported PDF. */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  fontSize: 11,
                  color: "#52525b",
                }}
                title={t("parsing.calloutOpacity")}
              >
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={Math.round(calloutOpacity * 100)}
                  onChange={(e) =>
                    setCalloutOpacity(Number(e.target.value) / 100)
                  }
                  aria-label={t("parsing.calloutOpacityAria")}
                  style={{
                    flex: 1,
                    accentColor: activeNoteColor,
                  }}
                />
                <span
                  style={{
                    minWidth: 32,
                    textAlign: "left",
                    fontVariantNumeric: "tabular-nums",
                    marginRight: "auto",
                  }}
                >
                  {Math.round(calloutOpacity * 100)}%
                </span>
              </div>

              {/* Callout typography defaults: text color, font size,
                  bold. Changes persist in the store AND are applied to
                  any currently-selected callout so the user sees the
                  effect immediately. */}
              {activeNoteKind === "callout" && (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    fontSize: 11,
                    color: "#52525b",
                  }}
                >
                  <label
                    style={{ display: "flex", alignItems: "center", gap: 4 }}
                    title={t("parsing.calloutTextColor")}
                  >
                    <span>{t("parsing.text")}</span>
                    <input
                      type="color"
                      value={calloutTextColor}
                      onChange={(e) => {
                        const next = e.target.value;
                        setCalloutTextColor(next);
                        if (
                          selectedPdfId &&
                          selectedNote &&
                          selectedNote.kind === "callout"
                        ) {
                          beginNoteEdit(selectedPdfId);
                          updateNote(selectedPdfId, selectedNote.id, {
                            textColor: next,
                          });
                        }
                      }}
                      style={{
                        width: 28,
                        height: 22,
                        border: "1px solid #d4d4d8",
                        background: "transparent",
                        padding: 0,
                        boxSizing: "border-box",
                      }}
                    />
                  </label>
                  <label
                    style={{ display: "flex", alignItems: "center", gap: 4 }}
                    title={t("parsing.calloutFontSize")}
                  >
                    <span>{t("parsing.size")}</span>
                    <input
                      type="number"
                      min={CALLOUT_FONT_SIZE_MIN}
                      max={CALLOUT_FONT_SIZE_MAX}
                      value={calloutDefaultFontSize}
                      onChange={(e) => {
                        const next = Math.max(
                          CALLOUT_FONT_SIZE_MIN,
                          Math.min(
                            CALLOUT_FONT_SIZE_MAX,
                            Number(e.target.value) || DEFAULT_CALLOUT_FONT_SIZE,
                          ),
                        );
                        setCalloutFontSize(next);
                        if (
                          selectedPdfId &&
                          selectedNote &&
                          selectedNote.kind === "callout"
                        ) {
                          beginNoteEdit(selectedPdfId);
                          updateNote(selectedPdfId, selectedNote.id, {
                            fontSize: next,
                          });
                        }
                      }}
                      style={{
                        width: 44,
                        height: 22,
                        padding: "2px 4px",
                        border: "1px solid #d4d4d8",
                        borderRadius: 4,
                        fontSize: 12,
                        boxSizing: "border-box",
                      }}
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() => {
                      const next = !calloutDefaultBold;
                      setCalloutBold(next);
                      if (
                        selectedPdfId &&
                        selectedNote &&
                        selectedNote.kind === "callout"
                      ) {
                        beginNoteEdit(selectedPdfId);
                        updateNote(selectedPdfId, selectedNote.id, {
                          bold: next,
                        });
                      }
                    }}
                    title={t("parsing.toggleBold")}
                    style={{
                      height: 22,
                      padding: "0 10px",
                      border: "1px solid #d4d4d8",
                      borderRadius: 4,
                      background: calloutDefaultBold ? "#1f2937" : "#fff",
                      color: calloutDefaultBold ? "#fff" : "#111",
                      fontWeight: 700,
                      cursor: "pointer",
                      boxSizing: "border-box",
                      lineHeight: 1,
                    }}
                  >
                    B
                  </button>
                </div>
              )}

              {/* Auto-annotate Not Found + Problematic references. Creates
                  a highlight over each matching reference and a Turkish
                  explanation callout directly below it. Idempotent — runs
                  twice produce the same set of notes. */}
              <button
                className={`${styles["zoom-btn"]} ${styles["zoom-text"]}`}
                onClick={handleAutoAnnotate}
                disabled={!selectedPdfId || sources.length === 0}
                title={t("parsing.autoAnnotateTitle")}
              >
                {t("parsing.autoAnnotate")}
              </button>

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
                    {selectedNote.kind === "callout" ? t("parsing.calloutLabel") : t("parsing.highlightLabel")}{" "}
                    · {t("parsing.page")} {selectedNote.pageNum + 1}
                  </span>
                  {selectedNote.kind === "callout" && (
                    <textarea
                      value={selectedNote.text}
                      onChange={(e) =>
                        handleUpdateSelectedNoteText(e.target.value)
                      }
                      onFocus={() => {
                        // Snapshot once per edit session so Ctrl+Z
                        // undoes the whole typing burst (not per-key).
                        if (selectedPdfId) beginNoteEdit(selectedPdfId);
                      }}
                      placeholder={t("parsing.calloutTextPlaceholder")}
                      ref={noteEditorRef}
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
                  )}
                  <button
                    className={`${styles["zoom-btn"]} ${styles["zoom-text"]}`}
                    onClick={handleDeleteSelectedNote}
                  >
                    {t("parsing.deleteNote")}
                  </button>
                </div>
              ) : (
                <span style={{ color: "#a8a29e", fontSize: 12 }}>
                  {activeNoteKind === "highlight"
                    ? t("parsing.dragToHighlight")
                    : t("parsing.dragToCallout")}
                </span>
              )}

              {/* Export */}
              <button
                className={`${styles["zoom-btn"]} ${styles["zoom-text"]} ${exportSuccess ? styles["export-success"] : ""}`}
                onClick={handleExportAnnotatedPdf}
                disabled={exportingPdf || notes.length === 0 || !pdfDoc}
                title={t("parsing.exportTitle")}
                style={{ marginTop: "auto" }}
              >
                {exportingPdf
                  ? t("parsing.exporting")
                  : exportSuccess
                    ? t("parsing.exported")
                    : t("parsing.export")}
              </button>
            </div>
          </>
        ) : selectedPdf ? (
          <>
            <div className={styles["panel-header"]}>
              <div className={styles["source-detail-heading"]}>
                <div className={styles["panel-tabs"]}>
                  <button
                    type="button"
                    className={`${styles["panel-tab"]} ${styles["panel-tab-active"]}`}
                    onClick={() => setActiveKind(null)}
                    title={t("parsing.showSourceDetail")}
                  >
                    {t("parsing.sourceDetail")}
                  </button>
                  <span className={styles["panel-tab-sep"]}>|</span>
                  <button
                    type="button"
                    className={`${styles["panel-tab"]}`}
                    onClick={() => setActiveKind("highlight")}
                    title={t("parsing.showNotes")}
                    disabled={!pdfDoc}
                  >
                    {t("parsing.notesTab")}{notes.length > 0 ? ` (${notes.length})` : ""}
                  </button>
                </div>
              </div>
            </div>

            <div className={styles["actions-content"]}>
              {selectedSource && (
                <div className={styles["source-detail"]}>
                  <div className={styles["detail-meta-row"]}>
                    <div className={styles["detail-meta-group"]}>
                      <span className={styles["detail-label"]}>{t("parsing.refHash")}</span>
                      <span className={styles["detail-value"]}>
                        {selectedSource.ref_number != null
                          ? selectedSource.ref_number
                          : "-"}
                      </span>
                    </div>
                    <div className={styles["detail-meta-group"]}>
                      <span className={styles["detail-label"]}>{t("parsing.page")}</span>
                      <span className={styles["detail-value"]}>
                        {selectedSource.bbox.page + 1}
                      </span>
                    </div>
                    <button
                      className={styles["detail-remove-icon"]}
                      onClick={() => handleRemoveSource(selectedSource.id)}
                      title={t("parsing.removeSource")}
                      aria-label={t("parsing.removeSource")}
                    >
                      &#x2715;
                    </button>
                  </div>

                  {/* Extracted fields */}
                  {parsedFieldsLoading && (
                    <div className={styles["fields-loading"]}>{t("parsing.extractingFields")}</div>
                  )}
                  {parsedFields && !parsedFieldsLoading && (
                    <div className={styles["parsed-fields"]}>
                      {parsedFields.title && (
                        <div className={styles["field-row"]}>
                          <span className={styles["field-label"]}>{t("parsing.fields.title")}</span>
                          <span className={styles["field-value"]}>{parsedFields.title}</span>
                        </div>
                      )}
                      {parsedFields.authors.length > 0 && (
                        <div className={styles["field-row"]}>
                          <span className={styles["field-label"]}>{t("parsing.fields.authors")}</span>
                          <span className={styles["field-value"]}>
                            {parsedFields.authors.join(", ")}
                          </span>
                        </div>
                      )}
                      {parsedFields.year && (
                        <div className={styles["field-row"]}>
                          <span className={styles["field-label"]}>{t("parsing.fields.year")}</span>
                          <span className={styles["field-value"]}>{parsedFields.year}</span>
                        </div>
                      )}
                      {parsedFields.source && (
                        <div className={styles["field-row"]}>
                          <span className={styles["field-label"]}>{t("parsing.fields.source")}</span>
                          <span className={styles["field-value"]}>{parsedFields.source}</span>
                        </div>
                      )}
                      {parsedFields.url && (
                        <div className={styles["field-row"]}>
                          <span className={styles["field-label"]}>{t("parsing.fields.url")}</span>
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
                        <span className={styles["field-label"]}>{t("parsing.fields.method")}</span>
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
                    <div className={styles["raw-text-header"]}>
                      <button
                        className={styles["raw-text-toggle"]}
                        onClick={() => setRawTextExpanded((v) => !v)}
                      >
                        <span className={styles["raw-text-toggle-icon"]}>
                          {rawTextExpanded ? "\u25BC" : "\u25B6"}
                        </span>
                        {t("parsing.rawText")}
                      </button>
                      {selectedSourceStatus && (
                        <div className={styles["source-status-tags"]}>
                          <span
                            className={`${styles["source-status-tag"]} ${styles["source-status-tag-active"]}`}
                          >
                            {t(`parsing.sourceStatus.${selectedSourceStatus}`)}
                          </span>
                        </div>
                      )}
                    </div>
                    {rawTextExpanded && (
                      <div className={styles["detail-text-display"]}>
                        {selectedSource.text || t("parsing.noTextDetected")}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {!selectedSource && (
                <div className={styles["actions-empty"]}>
                  <p className={styles["actions-empty-text"]}>
                    {t("parsing.selectSourceBox")}
                  </p>
                </div>
              )}
            </div>
          </>
        ) : (
          <div className={styles["actions-empty"]}>
            <p className={styles["actions-empty-text"]}>
              {t("parsing.selectDocumentActions")}
            </p>
          </div>
        )}
      </aside>
    </div>
  );
}
