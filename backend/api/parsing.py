"""Sources / cache / NER endpoints.

After Phase 4 of the PDF-handling migration, the backend no longer parses or
renders PDFs. Everything PDF-native (file reads, canvas rendering, reference
detection, bbox text extraction, annotation writing) runs in the Electron
renderer. The Python side is now only responsible for:

1. Persisting user-edited source rectangles to a JSON cache on disk
2. Managing approval status on those cached sources
3. Running the NER field extractor (still the only reason Python is in the loop)

The `pdf_store` in-memory cache, the parse job machinery, and all `fitz` /
`pymupdf` usage are gone. The `_save_to_cache` / `_load_from_cache` helpers
are the sole source of truth for source state and are shared with
verification.py via the module-level imports.
"""

import json

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from api.websocket import manager
from config import settings
from models.source import SourceRectangle

router = APIRouter()


# ---------------------------------------------------------------------------
# Disk cache helpers (shared with verification.py via direct import)
# ---------------------------------------------------------------------------


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
        if isinstance(raw, list):
            # Legacy format: plain list of sources, no numbered flag
            return [SourceRectangle(**item) for item in raw], False
        return [SourceRectangle(**item) for item in raw["sources"]], raw.get("numbered", False)
    except Exception:
        return None


def load_sources_for_pdf(pdf_id: str) -> list[SourceRectangle] | None:
    """Public helper used by verification.py to read the cached source list."""
    cached = _load_from_cache(pdf_id)
    return None if cached is None else cached[0]


# ---------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------


class UpdateSourcesRequest(BaseModel):
    sources: list[SourceRectangle]
    numbered: bool | None = None


class ExtractFieldsRequest(BaseModel):
    text: str


# ---------------------------------------------------------------------------
# Source cache CRUD
# ---------------------------------------------------------------------------


@router.get("/parse/sources/{pdf_id}")
async def get_sources(pdf_id: str):
    # Returns 200 with `cached=false` when no cache entry exists, rather
    # than 404, so the client's orchestrator can do a "check before parse"
    # without producing red network errors in devtools.
    cached = _load_from_cache(pdf_id)
    if cached is None:
        return {"sources": [], "cached": False}
    sources, numbered = cached
    approved = len(sources) > 0 and all(s.status == "approved" for s in sources)
    return {"sources": [s.model_dump() for s in sources], "cached": True, "numbered": numbered, "approved": approved}


@router.put("/parse/sources/{pdf_id}")
async def update_sources(pdf_id: str, request: UpdateSourcesRequest):
    # Determine the `numbered` flag to persist: explicit from the request
    # wins, then any previous cache entry, else False.
    if request.numbered is not None:
        numbered = request.numbered
    else:
        prev = _load_from_cache(pdf_id)
        numbered = prev[1] if prev is not None else False

    _save_to_cache(pdf_id, request.sources, numbered)

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


def _flip_status_and_persist(pdf_id: str, new_status: str) -> bool:
    cached = _load_from_cache(pdf_id)
    if cached is None:
        return False
    sources, numbered = cached
    for s in sources:
        s.status = new_status
    _save_to_cache(pdf_id, sources, numbered)
    return True


@router.post("/parse/approve/{pdf_id}")
async def approve_pdf(pdf_id: str):
    if not _flip_status_and_persist(pdf_id, "approved"):
        raise HTTPException(status_code=404, detail="PDF not found")
    await manager.broadcast("parse_approved", {"pdf_id": pdf_id})
    await manager.send_log("success", f"Sources approved for {pdf_id}", pdf_id=pdf_id)
    return {"success": True}


@router.post("/parse/unapprove/{pdf_id}")
async def unapprove_pdf(pdf_id: str):
    if not _flip_status_and_persist(pdf_id, "detected"):
        raise HTTPException(status_code=404, detail="PDF not found")
    await manager.broadcast("parse_unapproved", {"pdf_id": pdf_id})
    await manager.send_log("info", f"Approval revoked for {pdf_id}", pdf_id=pdf_id)
    return {"success": True}


@router.delete("/parse/pdf/{pdf_id}")
async def remove_pdf(pdf_id: str):
    """Drop the cached source + verify JSON files for a PDF."""
    cache_dir = settings.get_cache_dir()
    for name in (f"{pdf_id}.json", f"verify_{pdf_id}.json"):
        cache_file = cache_dir / name
        if cache_file.exists():
            try:
                cache_file.unlink()
            except Exception as e:
                print(f"[remove_pdf] failed to delete {cache_file}: {e}", flush=True)

    from api.verification import verify_results
    verify_results.pop(pdf_id, None)

    return {"success": True}


# ---------------------------------------------------------------------------
# NER field extraction (the one piece that still needs Python)
# ---------------------------------------------------------------------------


@router.post("/parse/extract-fields")
async def extract_fields(request: ExtractFieldsRequest):
    """Extract structured citation fields from raw reference text."""
    from services.source_extractor import extract_source_fields

    parsed = await extract_source_fields(request.text)
    return parsed.model_dump()
