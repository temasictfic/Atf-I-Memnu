import asyncio
import base64
import json
import uuid
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

from api.websocket import manager
from config import settings
from models.source import SourceRectangle

router = APIRouter()

# In-memory stores
parse_jobs: dict[str, dict] = {}
pdf_store: dict[str, dict] = {}  # pdf_id -> {document, sources, original_sources}


class ParseRequest(BaseModel):
    directory: str | None = None
    file_paths: list[str] | None = None
    force: bool = False


def _save_to_cache(pdf_id: str, sources: list[SourceRectangle], numbered: bool = False) -> None:
    cache_dir = settings.get_cache_dir()
    cache_file = cache_dir / f"{pdf_id}.json"
    data = {"sources": [s.model_dump() for s in sources], "numbered": numbered}
    try:
        cache_file.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    except Exception as e:
        print(f"[_save_to_cache] FAILED to write {cache_file}: {e}", flush=True)
        raise


def _load_from_cache(pdf_id: str) -> tuple[list[SourceRectangle], bool] | None:
    cache_file = settings.get_cache_dir() / f"{pdf_id}.json"
    if not cache_file.exists():
        return None
    try:
        raw = json.loads(cache_file.read_text(encoding="utf-8"))
        # Support old format (plain list) and new format (dict with numbered)
        if isinstance(raw, list):
            return [SourceRectangle(**item) for item in raw], False
        return [SourceRectangle(**item) for item in raw["sources"]], raw.get("numbered", False)
    except Exception:
        return None


class UpdateSourcesRequest(BaseModel):
    sources: list[SourceRectangle]


@router.post("/parse")
async def start_parsing(request: ParseRequest):
    pdf_files: list[Path] = []

    if request.file_paths:
        selected_files = [Path(path) for path in request.file_paths]

        missing_files = [str(path) for path in selected_files if not path.exists() or not path.is_file()]
        if missing_files:
            raise HTTPException(status_code=400, detail=f"File not found: {missing_files[0]}")

        non_pdf_files = [str(path) for path in selected_files if path.suffix.lower() != ".pdf"]
        if non_pdf_files:
            raise HTTPException(status_code=400, detail=f"Only PDF files are supported: {non_pdf_files[0]}")

        deduped_files: dict[str, Path] = {}
        for path in selected_files:
            deduped_files[str(path.resolve())] = path

        pdf_files = sorted(deduped_files.values(), key=lambda f: f.name.lower())
        if not pdf_files:
            raise HTTPException(status_code=400, detail="No PDF files selected")

        _save_last_directory(str(pdf_files[0].parent.resolve()))
    else:
        if not request.directory:
            raise HTTPException(status_code=400, detail="Provide either directory or file_paths")

        directory = Path(request.directory)
        if not directory.exists() or not directory.is_dir():
            raise HTTPException(status_code=400, detail=f"Directory not found: {request.directory}")

        pdf_files = sorted(
            [f for f in directory.iterdir() if f.suffix.lower() == ".pdf"],
            key=lambda f: f.name.lower(),
        )
        if not pdf_files:
            raise HTTPException(status_code=400, detail="No PDF files found in directory")

        # Save last directory to settings
        _save_last_directory(str(directory))

    job_id = str(uuid.uuid4())[:8]
    parse_jobs[job_id] = {"status": "running", "pdfs": []}

    # Start parsing in background
    asyncio.create_task(_parse_all_pdfs(job_id, pdf_files, request.force))

    return {"job_id": job_id}


def _save_last_directory(directory: str) -> None:
    try:
        from api.settings import _load_settings, _save_settings
        s = _load_settings()
        s.last_directory = directory
        _save_settings(s)
    except Exception:
        pass


@router.get("/parse/last-directory")
async def get_last_directory():
    try:
        from api.settings import _load_settings
        s = _load_settings()
        return {"directory": s.last_directory}
    except Exception:
        return {"directory": ""}


async def _parse_all_pdfs(job_id: str, pdf_files: list[Path], force: bool = False):
    from services.pdf_parser import parse_pdf
    from services.reference_detector import detect_references
    from concurrent.futures import ProcessPoolExecutor
    import functools

    await manager.send_log("info", f"Starting to parse {len(pdf_files)} PDFs")

    for pdf_path in pdf_files:
        pdf_id = pdf_path.stem
        parse_jobs[job_id]["pdfs"].append({"id": pdf_id, "name": pdf_path.name, "status": "parsing", "source_count": 0})

        await manager.broadcast("parse_started", {"pdf_id": pdf_id, "pdf_name": pdf_path.name})
        try:
            await _parse_single_pdf(job_id, pdf_id, pdf_path, force)
        except Exception:
            pass
        await asyncio.sleep(0)

    parse_jobs[job_id]["status"] = "done"
    await manager.broadcast("parse_all_done", {"total_pdfs": len(pdf_files)})
    await manager.send_log("success", f"All {len(pdf_files)} PDFs parsed")


async def _parse_single_pdf(job_id: str, pdf_id: str, pdf_path: Path, force: bool = False):
    try:
        from services.pdf_parser import parse_pdf
        from services.reference_detector import detect_references

        loop = asyncio.get_event_loop()

        # Check in-memory cache (already parsed this session)
        if not force and pdf_id in pdf_store:
            sources = pdf_store[pdf_id]["sources"]
            numbered = pdf_store[pdf_id].get("numbered", False)
            mem_approved = len(sources) > 0 and all(s.status == "approved" for s in sources)
            mem_status = "approved" if mem_approved else "parsed"
            await manager.send_log("info", f"Using cached result for {pdf_path.name}", pdf_id=pdf_id)

            for pdf_info in parse_jobs[job_id]["pdfs"]:
                if pdf_info["id"] == pdf_id:
                    pdf_info["status"] = mem_status
                    pdf_info["source_count"] = len(sources)

            if mem_approved:
                await manager.broadcast("parse_approved", {"pdf_id": pdf_id})

            await manager.broadcast(
                "parse_complete",
                {
                    "pdf_id": pdf_id,
                    "pdf_name": pdf_path.name,
                    "source_count": len(sources),
                    "sources": [s.model_dump() for s in sources],
                    "numbered": numbered,
                    "from_cache": "memory",
                },
            )
            await manager.send_log("success", f"Cached {pdf_path.name}: {len(sources)} sources", pdf_id=pdf_id)
            return

        # Check disk cache for sources
        cached = None if force else _load_from_cache(pdf_id)

        await manager.send_log("info", f"Parsing {pdf_path.name}...", pdf_id=pdf_id)

        # Always parse PDF for page images (needed for viewer)
        document = await loop.run_in_executor(None, parse_pdf, str(pdf_path))

        if cached is not None:
            # Use cached sources, skip reference detection
            sources, numbered = cached
            await manager.send_log("info", f"Loaded cached sources for {pdf_path.name}", pdf_id=pdf_id)
            # Check if all sources were previously approved
            all_approved = len(sources) > 0 and all(s.status == "approved" for s in sources)
        else:
            # Detect references fresh
            sources, numbered = await loop.run_in_executor(None, detect_references, document)
            # Save to disk cache
            _save_to_cache(pdf_id, sources, numbered)
            all_approved = False

        resolved_status = "approved" if all_approved else "parsed"

        # Store results
        pdf_store[pdf_id] = {
            "document": document,
            "sources": sources,
            "original_sources": [s.model_copy() for s in sources],
            "numbered": numbered,
        }

        # Update job status
        for pdf_info in parse_jobs[job_id]["pdfs"]:
            if pdf_info["id"] == pdf_id:
                pdf_info["status"] = resolved_status
                pdf_info["source_count"] = len(sources)

        await manager.broadcast(
            "parse_complete",
            {
                "pdf_id": pdf_id,
                "pdf_name": pdf_path.name,
                "source_count": len(sources),
                "sources": [s.model_dump() for s in sources],
                "numbered": numbered,
                "from_cache": "disk" if cached is not None else None,
            },
        )

        if all_approved:
            await manager.broadcast("parse_approved", {"pdf_id": pdf_id})
        await manager.send_log(
            "success",
            f"{'Approved' if all_approved else 'Parsed'} {pdf_path.name}: {len(sources)} sources",
            pdf_id=pdf_id,
        )

    except Exception as e:
        for pdf_info in parse_jobs[job_id]["pdfs"]:
            if pdf_info["id"] == pdf_id:
                pdf_info["status"] = "error"

        await manager.broadcast("parse_error", {"pdf_id": pdf_id, "error": str(e)})
        await manager.send_log("error", f"Failed to parse {pdf_path.name}: {e}", pdf_id=pdf_id)


@router.get("/parse/status/{job_id}")
async def get_parse_status(job_id: str):
    if job_id not in parse_jobs:
        raise HTTPException(status_code=404, detail="Job not found")
    return {"pdfs": parse_jobs[job_id]["pdfs"]}


@router.get("/parse/pages/{pdf_id}")
async def get_pages(pdf_id: str):
    """Return page data (dimensions + images) for native frontend rendering."""
    if pdf_id not in pdf_store:
        raise HTTPException(status_code=404, detail="PDF not found")
    document = pdf_store[pdf_id]["document"]
    pages = [
        {"page_num": p.page_num, "width": p.width, "height": p.height}
        for p in document.pages
    ]
    return {"pages": pages}


@router.get("/parse/page-image/{pdf_id}/{page_num}")
async def get_page_image(pdf_id: str, page_num: int):
    """Return a single page image as raw PNG bytes."""
    if pdf_id not in pdf_store:
        raise HTTPException(status_code=404, detail="PDF not found")
    document = pdf_store[pdf_id]["document"]
    for page in document.pages:
        if page.page_num == page_num:
            png_bytes = base64.b64decode(page.image_base64)
            return Response(content=png_bytes, media_type="image/png",
                            headers={"Cache-Control": "public, max-age=3600"})
    raise HTTPException(status_code=404, detail="Page not found")


@router.get("/parse/sources/{pdf_id}")
async def get_sources(pdf_id: str):
    if pdf_id not in pdf_store:
        raise HTTPException(status_code=404, detail="PDF not found")
    return {"sources": [s.model_dump() for s in pdf_store[pdf_id]["sources"]]}


@router.put("/parse/sources/{pdf_id}")
async def update_sources(pdf_id: str, request: UpdateSourcesRequest):
    if pdf_id not in pdf_store:
        print(f"[update_sources] 404: pdf_id={pdf_id} not in pdf_store (keys={list(pdf_store.keys())})", flush=True)
        raise HTTPException(status_code=404, detail="PDF not found")
    print(f"[update_sources] {pdf_id}: {len(request.sources)} sources", flush=True)
    pdf_store[pdf_id]["sources"] = request.sources
    _save_to_cache(pdf_id, request.sources, pdf_store[pdf_id].get("numbered", False))
    cache_file = settings.get_cache_dir() / f"{pdf_id}.json"
    print(f"[update_sources] wrote {cache_file} ({cache_file.stat().st_size} bytes)", flush=True)
    # Clean stale verify results for removed/renumbered sources
    _clean_verify_cache(pdf_id, {s.id for s in request.sources})
    # Also clean in-memory verify results
    from api.verification import verify_results
    if pdf_id in verify_results:
        current_ids = {s.id for s in request.sources}
        verify_results[pdf_id] = {
            k: v for k, v in verify_results[pdf_id].items() if k in current_ids
        }
    return {"success": True}


def _clean_verify_cache(pdf_id: str, current_source_ids: set[str]) -> None:
    """Remove verify cache entries for sources that no longer exist."""
    cache_file = settings.get_cache_dir() / f"verify_{pdf_id}.json"
    if not cache_file.exists():
        return
    try:
        data = json.loads(cache_file.read_text(encoding="utf-8"))
        cleaned = {k: v for k, v in data.items() if k in current_source_ids}
        if len(cleaned) != len(data):
            cache_file.write_text(json.dumps(cleaned, ensure_ascii=False), encoding="utf-8")
    except Exception:
        pass


@router.post("/parse/approve/{pdf_id}")
async def approve_pdf(pdf_id: str):
    if pdf_id not in pdf_store:
        raise HTTPException(status_code=404, detail="PDF not found")

    for s in pdf_store[pdf_id]["sources"]:
        s.status = "approved"

    # Update document status
    doc = pdf_store[pdf_id]["document"]
    doc.status = "approved"

    # Persist approved status to disk cache
    _save_to_cache(pdf_id, pdf_store[pdf_id]["sources"], pdf_store[pdf_id].get("numbered", False))

    await manager.broadcast("parse_approved", {"pdf_id": pdf_id})
    await manager.send_log("success", f"Sources approved for {pdf_id}", pdf_id=pdf_id)
    return {"success": True}


@router.post("/parse/unapprove/{pdf_id}")
async def unapprove_pdf(pdf_id: str):
    if pdf_id not in pdf_store:
        raise HTTPException(status_code=404, detail="PDF not found")

    for s in pdf_store[pdf_id]["sources"]:
        s.status = "detected"

    doc = pdf_store[pdf_id]["document"]
    doc.status = "parsed"

    _save_to_cache(pdf_id, pdf_store[pdf_id]["sources"], pdf_store[pdf_id].get("numbered", False))

    await manager.broadcast("parse_unapproved", {"pdf_id": pdf_id})
    await manager.send_log("info", f"Approval revoked for {pdf_id}", pdf_id=pdf_id)
    return {"success": True}


class ExtractTextRequest(BaseModel):
    page: int
    x0: float
    y0: float
    x1: float
    y1: float


@router.post("/parse/extract-text/{pdf_id}")
async def extract_text_from_region(pdf_id: str, request: ExtractTextRequest):
    """Extract text that falls within a bounding box on a specific page."""
    if pdf_id not in pdf_store:
        raise HTTPException(status_code=404, detail="PDF not found")

    document = pdf_store[pdf_id]["document"]
    page = None
    for p in document.pages:
        if p.page_num == request.page:
            page = p
            break

    if page is None:
        return {"text": ""}

    # Collect text blocks that overlap with the given bbox
    texts = []
    for block in page.text_blocks:
        bx0, by0, bx1, by1 = block.bbox
        # Check overlap: block intersects the request region
        if bx1 > request.x0 and bx0 < request.x1 and by1 > request.y0 and by0 < request.y1:
            texts.append(block.text)

    return {"text": " ".join(texts)}


class ExtractFieldsRequest(BaseModel):
    text: str


@router.post("/parse/extract-fields")
async def extract_fields(request: ExtractFieldsRequest):
    """Extract structured citation fields from raw reference text using NER + regex fallback."""
    from services.source_extractor import extract_source_fields

    parsed = await extract_source_fields(request.text)
    return parsed.model_dump()


@router.post("/parse/revert/{pdf_id}")
async def revert_pdf(pdf_id: str):
    if pdf_id not in pdf_store:
        raise HTTPException(status_code=404, detail="PDF not found")

    original = pdf_store[pdf_id]["original_sources"]
    pdf_store[pdf_id]["sources"] = [s.model_copy() for s in original]
    return {"sources": [s.model_dump() for s in pdf_store[pdf_id]["sources"]]}
