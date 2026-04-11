import asyncio
import json
import uuid

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from api.websocket import manager
from api.parsing import pdf_store
from config import settings
from models.verification_result import VerificationResult

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


async def _verify_batch(job_id: str, pdf_ids: list[str], texts: dict[str, str], excluded_ids: set[str]):
    from services.verification_orchestrator import verify_pdf_sources_filtered

    await manager.send_log("info", f"Starting batch verification for {len(pdf_ids)} PDFs")

    tasks = []
    for pdf_id in pdf_ids:
        if pdf_id not in pdf_store:
            continue
        tasks.append(verify_pdf_sources_filtered(
            pdf_id, pdf_store[pdf_id]["sources"], verify_results, texts, excluded_ids
        ))

    await asyncio.gather(*tasks, return_exceptions=True)

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

    tasks = []
    for pdf_id in pdf_ids:
        if pdf_id not in pdf_store:
            continue
        tasks.append(verify_pdf_sources(pdf_id, pdf_store[pdf_id]["sources"], verify_results))

    await asyncio.gather(*tasks, return_exceptions=True)

    # Save results to disk cache
    for pdf_id in pdf_ids:
        if pdf_id in verify_results and verify_results[pdf_id]:
            _save_verify_cache(pdf_id, verify_results[pdf_id])

    verify_jobs[job_id]["status"] = "done"
    await manager.send_log("success", f"Verification complete for all PDFs")


@router.post("/verify/pdf/{pdf_id}")
async def reverify_pdf(pdf_id: str):
    if pdf_id not in pdf_store:
        raise HTTPException(status_code=404, detail="PDF not found")

    from services.verification_orchestrator import verify_pdf_sources

    job_id = str(uuid.uuid4())[:8]
    asyncio.create_task(verify_pdf_sources(pdf_id, pdf_store[pdf_id]["sources"], verify_results))
    return {"job_id": job_id}


@router.post("/verify/source/{pdf_id}/{source_id}")
async def reverify_source(pdf_id: str, source_id: str, request: VerifySourceRequest):
    if pdf_id not in pdf_store:
        raise HTTPException(status_code=404, detail="PDF not found")

    sources = pdf_store[pdf_id]["sources"]
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
