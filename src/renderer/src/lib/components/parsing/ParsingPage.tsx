import {
  useState,
  useMemo,
  useEffect,
  useLayoutEffect,
  useRef,
  useCallback,
} from "react";
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
} from "../../stores/sources-store";
import { clearVerificationForPdf } from "../../stores/verification-store";
import type { SourceRectangle, PageData } from "../../api/types";
import { api, pageImageUrl } from "../../api/rest-client";
import styles from "./ParsingPage.module.css";

const statusOrder: Record<string, number> = {
  approved: 0,
  parsed: 1,
  parsing: 2,
  pending: 3,
  error: 4,
};

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
  const selectedPdfId = usePdfStore((s) => s.selectedPdfId);
  const loading = usePdfStore((s) => s.loading);
  const selectPdf = usePdfStore((s) => s.selectPdf);
  const removePdf = usePdfStore((s) => s.removePdf);
  const sortKey = usePdfStore((s) => s.parsingSortKey);
  const sortAsc = usePdfStore((s) => s.parsingSortAsc);
  const { toggleParsingSort } = usePdfStore.getState();

  const sourcesByPdf = useSourcesStore((s) => s.sourcesByPdf);
  const historyByPdf = useSourcesStore((s) => s.historyByPdf);

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
  const [scale, setScale] = useState(1);
  const [containerWidth, setContainerWidth] = useState(0);
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
  const [manualCounter, setManualCounter] = useState(0);

  // Refs for interaction state (not reactive, no re-render needed)
  const viewerRef = useRef<HTMLElement>(null);
  const loadedPdfIdRef = useRef<string | null>(null);
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
    const list = [...allPdfs];
    const dir = sortAsc ? 1 : -1;
    list.sort((a, b) => {
      if (sortKey === "name") return dir * a.name.localeCompare(b.name);
      if (sortKey === "status")
        return (
          dir * ((statusOrder[a.status] ?? 9) - (statusOrder[b.status] ?? 9))
        );
      return dir * (a.source_count - b.source_count);
    });
    return list;
  }, [allPdfs, sortKey, sortAsc]);

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

  // Auto fit-to-width
  useEffect(() => {
    if (fitScale > 0 && pages.length > 0) setScale(fitScale);
  }, [fitScale, pages.length]);

  // ResizeObserver
  useEffect(() => {
    const el = viewerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) setContainerWidth(entry.contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

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

  async function loadPdfPages(pdfId: string) {
    setLoadingPages(true);
    setSelectedSourceId(null);
    try {
      const result = await api.getPages(pdfId);
      setPages(result.pages);
      await loadSources(pdfId);
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
    if (!pdf || pdf.status === "parsing") return;

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
    revert(selectedPdfId);
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
  }, [onWheel]);

  // Apply scroll correction after scale changes to keep zoom anchored
  useLayoutEffect(() => {
    if (pendingScrollRef.current && viewerRef.current) {
      const el = viewerRef.current;
      el.scrollLeft = pendingScrollRef.current.left;
      el.scrollTop = pendingScrollRef.current.top;
      pendingScrollRef.current = null;
    }
  }, [scale]);

  // Text extraction
  async function extractAndSetText(
    pdfId: string,
    sourceId: string,
    bbox: { x0: number; y0: number; x1: number; y1: number; page: number },
  ) {
    try {
      const result = await api.extractText(
        pdfId,
        bbox.page,
        bbox.x0,
        bbox.y0,
        bbox.x1,
        bbox.y1,
      );
      if (result.text) {
        updateRectangle(pdfId, sourceId, { text: result.text });
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

  const onMouseUp = useCallback((_e: React.MouseEvent) => {
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
      saveSources(pdfId);
      const currentSources =
        useSourcesStore.getState().sourcesByPdf[pdfId] ?? [];
      const movedSource = currentSources.find(
        (s) => s.id === dragIntentRef.current!.sourceId,
      );
      if (movedSource)
        extractAndSetText(
          pdfId,
          dragIntentRef.current.sourceId,
          movedSource.bbox,
        );
    }
    if (hadResize && pdfId) {
      saveSources(pdfId);
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
  }

  const selectedSource = useMemo(
    () =>
      selectedSourceId
        ? (sources.find((s) => s.id === selectedSourceId) ?? null)
        : null,
    [sources, selectedSourceId],
  );
  const selectedSourceStatus = selectedSource?.status ?? null;

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
                    className={`${styles["pdf-status"]} ${pdf.status !== "parsing" ? styles["pdf-status-removable"] : ""}`}
                    title={
                      pdf.status === "parsing"
                        ? "Cannot remove while parsing"
                        : "Remove from list"
                    }
                    onClick={(e) => {
                      if (pdf.status === "parsing") return;
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
                    {pdf.status !== "parsing" && (
                      <span className={styles["pdf-status-remove"]}>
                        &times;
                      </span>
                    )}
                  </span>
                  <span className={styles["pdf-name"]} title={pdf.name}>
                    {pdf.name}
                  </span>
                  <span className={styles["pdf-count"]}>{pdf.source_count}</span>
                </button>
              </div>
            ))
          )}
        </div>
      </aside>

      {/* Center Panel: PDF Viewer */}
      <section className={styles["viewer-panel"]} ref={viewerRef}>
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
                        <span className={styles["hint-keys"]}>Right click</span>
                        <span className={styles["hint-desc"]}>Draw new</span>
                      </div>
                      <div className={styles["hint-row"]}>
                        <span className={styles["hint-keys"]}>Del</span>
                        <span className={styles["hint-desc"]}>Remove source</span>
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
                <span className={styles["count-badge"]}>{sources.length} sources</span>
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
              role="button"
              tabIndex={0}
              aria-label="Document view (press Enter or Space to clear selection)"
              onClick={onPageClick}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onPageClick();
                }
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
              >
                {pages.map((page, idx) => (
                  <div key={page.page_num}>
                    <img
                      src={
                        selectedPdfId
                          ? pageImageUrl(selectedPdfId, page.page_num)
                          : ""
                      }
                      alt={`Page ${page.page_num + 1}`}
                      style={{
                        position: "absolute",
                        top: pageOffsets[idx] * scale,
                        left: ((maxPageWidth - page.width) / 2) * scale,
                        width: page.width * scale,
                        height: page.height * scale,
                        display: "block",
                      }}
                      draggable={false}
                    />
                    {idx > 0 && (
                      <div
                        className={styles["page-boundary"]}
                        style={{
                          top: pageOffsets[idx] * scale,
                          width: maxPageWidth * scale,
                        }}
                      />
                    )}
                    {/* Source rectangles for this page */}
                    {sourcesForPage(page.page_num).map((source) => (
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
                    {/* Multi-page continuation bboxes */}
                    {extraBboxesForPage(page.page_num).map(
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
            </div>

            {/* Draw preview rectangle */}
            {drawingState && (
              <div
                className={styles["draw-preview"]}
                style={drawPreviewStyle()}
              />
            )}
          </>
        ) : (
          <div className={styles["viewer-empty"]}>
            <p>Unable to load document</p>
          </div>
        )}
      </section>

      {/* Right Panel: Actions & Source Detail */}
      <aside className={styles["actions-panel"]}>
        {selectedPdf ? (
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
                  <div className={styles["detail-text-display"]}>
                    {selectedSource.text || "(no text detected)"}
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
