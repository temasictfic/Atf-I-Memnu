import asyncio
import json
import uuid

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from api.websocket import manager
from api.parsing import load_sources_for_pdf
from config import settings
from models.source import SourceRectangle
from models.verification_result import VerificationResult, MatchResult

router = APIRouter()

# In-memory verification results
verify_jobs: dict[str, dict] = {}
verify_results: dict[str, dict[str, VerificationResult]] = {}  # pdf_id -> {source_id -> result}


def _save_verify_cache(pdf_id: str, results: dict[str, VerificationResult]) -> None:
    """Persist verification results to disk cache."""
    cache_dir = settings.get_cache_dir()
    cache_file = cache_dir / f"verify_{pdf_id}.json"
    data = {k: v.model_dump() for k, v in results.items()}
    cache_file.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")


_LEGACY_STATUS_MAP = {
    "green": "found",
    "yellow": "problematic",
    "red": "problematic",
    "black": "not_found",
}


def _load_verify_cache(pdf_id: str) -> dict[str, VerificationResult] | None:
    """Load verification results from disk cache.

    Migrates legacy 4-category statuses (green/yellow/red/black) to the
    3-category model (found/problematic/not_found).
    """
    cache_file = settings.get_cache_dir() / f"verify_{pdf_id}.json"
    if not cache_file.exists():
        return None
    try:
        data = json.loads(cache_file.read_text(encoding="utf-8"))
        migrated = False
        normalized: dict[str, VerificationResult] = {}
        for source_id, payload in data.items():
            entry = dict(payload)
            old_status = entry.get("status")
            if old_status in _LEGACY_STATUS_MAP:
                entry["status"] = _LEGACY_STATUS_MAP[old_status]
                migrated = True
            # Drop journal_match from legacy MatchDetails entries
            for m in (entry.get("all_results") or []):
                md = m.get("match_details") or {}
                md.pop("journal_match", None)
            best = entry.get("best_match")
            if isinstance(best, dict):
                md = best.get("match_details") or {}
                md.pop("journal_match", None)
            normalized[source_id] = VerificationResult(**entry)

        if migrated:
            _save_verify_cache(pdf_id, normalized)

        return normalized
    except Exception:
        return None


class VerifyRequest(BaseModel):
    pdf_ids: list[str]


class VerifySourceRequest(BaseModel):
    text: str | None = None


class OverrideRequest(BaseModel):
    status: str  # found, problematic, not_found


class VerifyBatchRequest(BaseModel):
    pdf_ids: list[str]
    texts: dict[str, str] = {}
    excluded_ids: list[str] = []


@router.post("/verify/batch")
async def start_batch_verification(request: VerifyBatchRequest):
    job_id = str(uuid.uuid4())[:8]
    verify_jobs[job_id] = {"status": "running", "pdfs": request.pdf_ids}

    asyncio.create_task(_verify_batch(
        job_id, request.pdf_ids, request.texts, set(request.excluded_ids)
    ))
    return {"job_id": job_id}


def _load_sources_or_empty(pdf_id: str) -> list[SourceRectangle]:
    """Load cached sources for a PDF. Used everywhere pdf_store was used before."""
    sources = load_sources_for_pdf(pdf_id)
    return sources if sources is not None else []


async def _verify_batch(job_id: str, pdf_ids: list[str], texts: dict[str, str], excluded_ids: set[str]):
    from services.verification_orchestrator import verify_pdf_sources_filtered

    await manager.send_log("info", f"Starting batch verification for {len(pdf_ids)} PDFs")

    for pid in pdf_ids:
        sources = _load_sources_or_empty(pid)
        if not sources:
            continue
        try:
            await verify_pdf_sources_filtered(
                pid, sources, verify_results, texts, excluded_ids
            )
        except Exception as e:
            await manager.send_log("error", f"Verification failed for {pid}: {e}")

    # Save results to disk cache
    for pdf_id in pdf_ids:
        if pdf_id in verify_results and verify_results[pdf_id]:
            _save_verify_cache(pdf_id, verify_results[pdf_id])

    verify_jobs[job_id]["status"] = "done"
    await manager.send_log("success", "Batch verification complete")


@router.post("/verify")
async def start_verification(request: VerifyRequest):
    job_id = str(uuid.uuid4())[:8]
    verify_jobs[job_id] = {"status": "running", "pdfs": request.pdf_ids}

    asyncio.create_task(_verify_all_pdfs(job_id, request.pdf_ids))
    return {"job_id": job_id}


async def _verify_all_pdfs(job_id: str, pdf_ids: list[str]):
    from services.verification_orchestrator import verify_pdf_sources

    await manager.send_log("info", f"Starting verification for {len(pdf_ids)} PDFs")

    for pid in pdf_ids:
        sources = _load_sources_or_empty(pid)
        if not sources:
            continue
        try:
            await verify_pdf_sources(pid, sources, verify_results)
        except Exception as e:
            await manager.send_log("error", f"Verification failed for {pid}: {e}")

    # Save results to disk cache
    for pdf_id in pdf_ids:
        if pdf_id in verify_results and verify_results[pdf_id]:
            _save_verify_cache(pdf_id, verify_results[pdf_id])

    verify_jobs[job_id]["status"] = "done"
    await manager.send_log("success", f"Verification complete for all PDFs")


@router.post("/verify/pdf/{pdf_id}")
async def reverify_pdf(pdf_id: str):
    sources = _load_sources_or_empty(pdf_id)
    if not sources:
        raise HTTPException(status_code=404, detail="PDF not found")

    from services.verification_orchestrator import verify_pdf_sources

    job_id = str(uuid.uuid4())[:8]
    asyncio.create_task(verify_pdf_sources(pdf_id, sources, verify_results))
    return {"job_id": job_id}


@router.post("/verify/source/{pdf_id}/{source_id}")
async def reverify_source(pdf_id: str, source_id: str, request: VerifySourceRequest):
    sources = _load_sources_or_empty(pdf_id)
    if not sources:
        raise HTTPException(status_code=404, detail="PDF not found")

    source = next((s for s in sources if s.id == source_id), None)
    if not source:
        raise HTTPException(status_code=404, detail="Source not found")

    from services.verification_orchestrator import verify_single_source, _register_task

    # Use updated text if provided
    text = request.text if request.text is not None else source.text
    task = asyncio.create_task(verify_single_source(pdf_id, source_id, text, verify_results))
    _register_task(source_id, task)
    return {"success": True}


@router.post("/verify/cancel")
async def cancel_all_verification():
    from services.verification_orchestrator import cancel_all_active
    cancel_all_active()
    await manager.send_log("info", "Verification cancelled by user")
    return {"success": True}


@router.post("/verify/cancel/pdf/{pdf_id}")
async def cancel_pdf_verification(pdf_id: str):
    from services.verification_orchestrator import request_cancel
    request_cancel(pdf_id)
    await manager.send_log("info", f"Verification cancelled for {pdf_id}", pdf_id=pdf_id)
    return {"success": True}


@router.post("/verify/cancel/source/{source_id}")
async def cancel_source_verification(source_id: str):
    from services.verification_orchestrator import request_cancel
    request_cancel(source_id)
    return {"success": True}


@router.get("/verify/status/{job_id}")
async def get_verify_status(job_id: str):
    if job_id not in verify_jobs:
        raise HTTPException(status_code=404, detail="Job not found")

    job = verify_jobs[job_id]
    job_done = job["status"] == "done"

    summaries = []
    for pdf_id in job["pdfs"]:
        results = verify_results.get(pdf_id, {})
        found = sum(1 for r in results.values() if r.status == "found")
        problematic = sum(1 for r in results.values() if r.status == "problematic")
        not_found = sum(1 for r in results.values() if r.status == "not_found")
        in_progress = sum(1 for r in results.values() if r.status == "in_progress")

        # A PDF is completed if: no in-progress sources AND either
        # it has results OR the entire job is done (handles excluded/empty PDFs)
        completed = in_progress == 0 and (len(results) > 0 or job_done)

        summaries.append({
            "pdf_id": pdf_id,
            "found": found,
            "problematic": problematic,
            "not_found": not_found,
            "in_progress": in_progress,
            "total": len(results),
            "completed": completed,
        })

    return {"pdfs": summaries}


@router.get("/verify/results/{pdf_id}")
async def get_verify_results(pdf_id: str):
    results = verify_results.get(pdf_id)
    if results is None:
        # Try loading from disk cache
        cached = _load_verify_cache(pdf_id)
        if cached:
            verify_results[pdf_id] = cached
            results = cached
        else:
            results = {}
    return {"results": {k: v.model_dump() for k, v in results.items()}}


@router.put("/verify/override/{pdf_id}/{source_id}")
async def override_status(pdf_id: str, source_id: str, request: OverrideRequest):
    if pdf_id not in verify_results or source_id not in verify_results[pdf_id]:
        raise HTTPException(status_code=404, detail="Result not found")

    verify_results[pdf_id][source_id].status = request.status

    # Recalculate counts
    results = verify_results[pdf_id]
    found = sum(1 for r in results.values() if r.status == "found")
    problematic = sum(1 for r in results.values() if r.status == "problematic")
    not_found = sum(1 for r in results.values() if r.status == "not_found")

    await manager.broadcast("verify_pdf_updated", {
        "pdf_id": pdf_id,
        "found": found,
        "problematic": problematic,
        "not_found": not_found,
    })
    await manager.send_log(
        "info",
        f"Source [{source_id}] status overridden to {request.status.upper()}",
        pdf_id=pdf_id,
        source_id=source_id,
    )

    # Persist updated results to disk cache
    _save_verify_cache(pdf_id, verify_results[pdf_id])

    return {"success": True}


class ScholarCandidate(BaseModel):
    title: str
    authors: list[str] = []
    year: int | None = None
    doi: str | None = None
    url: str = ""


class ScoreScholarRequest(BaseModel):
    pdf_id: str
    source_id: str
    source_text: str
    candidates: list[ScholarCandidate]


@router.post("/verify/score-scholar")
async def score_scholar(request: ScoreScholarRequest):
    """Score Google Scholar candidates against a source and merge into results."""
    from services.source_extractor import extract_source_fields
    from services.match_scorer import score_match, determine_verification_status

    parsed = await extract_source_fields(request.source_text)

    scholar_matches: list[MatchResult] = []
    search_url = f"https://scholar.google.com/scholar?q={request.source_text[:200]}"

    for cand in request.candidates:
        match = score_match(parsed, {
            "title": cand.title,
            "authors": cand.authors,
            "year": cand.year,
            "doi": cand.doi,
            "url": cand.url,
            "database": "Google Scholar",
            "search_url": search_url,
        })
        scholar_matches.append(match)

    # Merge into existing results
    existing = verify_results.get(request.pdf_id, {}).get(request.source_id)
    if existing is None:
        return {"updated": False, "result": None}

    # Always record that Google Scholar was searched, even if it returned
    # nothing — users need to see the GS link under DATABASE RESULTS.
    if "Google Scholar" not in existing.databases_searched:
        existing.databases_searched.append("Google Scholar")

    if scholar_matches:
        existing.all_results.extend(scholar_matches)
        best_scholar = max(scholar_matches, key=lambda m: m.score)
        if existing.best_match is None or best_scholar.score > existing.best_match.score:
            existing.best_match = best_scholar
        existing.all_results.sort(key=lambda m: m.score, reverse=True)

    # Re-determine status with potentially new best match
    status, problem_tags = determine_verification_status(
        parsed, existing.best_match, existing.url_liveness
    )
    existing.status = status
    existing.problem_tags = problem_tags

    # Persist and broadcast
    _save_verify_cache(request.pdf_id, verify_results[request.pdf_id])

    await manager.broadcast("verify_source_done", {
        "pdf_id": request.pdf_id,
        "source_id": request.source_id,
        "status": status,
        "problem_tags": problem_tags,
        "url_liveness": existing.url_liveness,
        "best_match": existing.best_match.model_dump() if existing.best_match else None,
        "all_results": [m.model_dump() for m in existing.all_results],
        "databases_searched": list(existing.databases_searched),
        "scholar_url": existing.scholar_url,
        "google_url": existing.google_url,
    })

    # Recalculate and broadcast PDF counts
    results = verify_results[request.pdf_id]
    found = sum(1 for r in results.values() if r.status == "found")
    problematic = sum(1 for r in results.values() if r.status == "problematic")
    not_found = sum(1 for r in results.values() if r.status == "not_found")

    await manager.broadcast("verify_pdf_updated", {
        "pdf_id": request.pdf_id,
        "found": found,
        "problematic": problematic,
        "not_found": not_found,
    })

    return {
        "updated": True,
        "result": existing.model_dump(),
    }
