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
from services.scoring_constants import LOW_PARSE_CONFIDENCE_THRESHOLD
from services.search_urls import build_google_urls, build_search_url

router = APIRouter()

# In-memory verification results
verify_jobs: dict[str, dict] = {}
verify_results: dict[str, dict[str, VerificationResult]] = {}  # pdf_id -> {source_id -> result}


def _is_best_match(m: MatchResult, best: MatchResult | None) -> bool:
    """Identify the all_results entry that should carry best_match=True on disk.

    Matches by (database, score, title) — strong enough to disambiguate
    across the rare ties we see (each verifier returns a single result, so
    the full triple is unique in practice).
    """
    if best is None:
        return False
    return (m.database, m.score, m.title) == (best.database, best.score, best.title)


def _serialise_match(m: MatchResult, is_best: bool) -> dict:
    """Dump a MatchResult for disk: drop search_url + defaults, add best_match flag."""
    d = m.model_dump(exclude={"search_url"}, exclude_defaults=True)
    d["best_match"] = is_best
    return d


def _serialise_result(r: VerificationResult) -> dict:
    """Dump a VerificationResult for disk in the optimised cache shape."""
    payload = r.model_dump(
        exclude={"source_id", "best_match", "all_results", "scholar_url", "google_url"},
        exclude_defaults=True,
    )
    payload["all_results"] = [_serialise_match(m, _is_best_match(m, r.best_match)) for m in r.all_results]
    return payload


def _save_verify_cache(pdf_id: str, results: dict[str, VerificationResult]) -> None:
    """Persist verification results to disk cache."""
    cache_dir = settings.get_cache_dir()
    cache_file = cache_dir / f"verify_{pdf_id}.json"
    data = {sid: _serialise_result(r) for sid, r in results.items()}
    cache_file.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")


def _hydrate_match(entry: dict, parsed_title: str) -> tuple[MatchResult, bool]:
    """Rehydrate a MatchResult from disk; rebuild search_url; return is_best flag."""
    is_best = bool(entry.pop("best_match", False))
    database = entry.get("database", "")
    entry["search_url"] = build_search_url(database, parsed_title)
    return MatchResult(**entry), is_best


def _hydrate_result(source_id: str, payload: dict) -> VerificationResult:
    """Rehydrate a VerificationResult from disk: inject source_id, reconstruct
    best_match from the flagged all_results entry, rebuild search/scholar/google URLs."""
    payload = dict(payload)  # don't mutate caller's data
    parsed_title = payload.get("parsed_title", "") or ""

    raw_all = payload.pop("all_results", [])
    all_results: list[MatchResult] = []
    best_match: MatchResult | None = None
    for entry in raw_all:
        m, is_best = _hydrate_match(dict(entry), parsed_title)
        all_results.append(m)
        if is_best:
            best_match = m

    scholar_url, google_url = build_google_urls(parsed_title)
    return VerificationResult(
        source_id=source_id,
        all_results=all_results,
        best_match=best_match,
        scholar_url=scholar_url,
        google_url=google_url,
        **payload,
    )


def _load_verify_cache(pdf_id: str) -> dict[str, VerificationResult] | None:
    """Load verification results from disk cache."""
    cache_file = settings.get_cache_dir() / f"verify_{pdf_id}.json"
    if not cache_file.exists():
        return None
    try:
        data = json.loads(cache_file.read_text(encoding="utf-8"))
        return {sid: _hydrate_result(sid, payload) for sid, payload in data.items()}
    except Exception:
        return None


class VerifyRequest(BaseModel):
    pdf_ids: list[str]


class VerifySourceRequest(BaseModel):
    text: str | None = None


class OverrideRequest(BaseModel):
    status: str  # high, medium, low


class TagOverrideRequest(BaseModel):
    tag: str            # "authors" | "year" | "title" | "journal" | "doi/arXiv"
    state: bool | None  # None clears the override


class DecisionOverrideRequest(BaseModel):
    decision: str | None   # "valid" | "citation" | "fabricated" | None (clear)


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
        high = sum(1 for r in results.values() if r.status == "high")
        medium = sum(1 for r in results.values() if r.status == "medium")
        low = sum(1 for r in results.values() if r.status == "low")
        in_progress = sum(1 for r in results.values() if r.status == "in_progress")

        # A PDF is completed if: no in-progress sources AND either
        # it has results OR the entire job is done (handles excluded/empty PDFs)
        completed = in_progress == 0 and (len(results) > 0 or job_done)

        summaries.append({
            "pdf_id": pdf_id,
            "high": high,
            "medium": medium,
            "low": low,
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
    high = sum(1 for r in results.values() if r.status == "high")
    medium = sum(1 for r in results.values() if r.status == "medium")
    low = sum(1 for r in results.values() if r.status == "low")

    await manager.broadcast("verify_pdf_updated", {
        "pdf_id": pdf_id,
        "high": high,
        "medium": medium,
        "low": low,
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


_ALLOWED_TAG_KEYS = {"authors", "year", "title", "journal", "doi/arXiv"}


@router.post("/verify/tag-override/{pdf_id}/{source_id}")
async def set_tag_override(pdf_id: str, source_id: str, request: TagOverrideRequest):
    """Store per-tag ON/OFF overrides for a source card.

    state=True  → force ON
    state=False → force OFF
    state=None  → clear override (revert to default-derived state)
    """
    if request.tag not in _ALLOWED_TAG_KEYS:
        raise HTTPException(status_code=400, detail=f"Unknown tag: {request.tag}")
    if pdf_id not in verify_results or source_id not in verify_results[pdf_id]:
        raise HTTPException(status_code=404, detail="Result not found")

    existing = verify_results[pdf_id][source_id]
    if request.state is None:
        existing.tag_overrides.pop(request.tag, None)
    else:
        existing.tag_overrides[request.tag] = request.state

    _save_verify_cache(pdf_id, verify_results[pdf_id])

    await manager.broadcast("verify_source_done", {
        "pdf_id": pdf_id,
        "source_id": source_id,
        "status": existing.status,
        "problem_tags": existing.problem_tags,
        "decision_tag": existing.decision_tag,
        "decision_tag_override": existing.decision_tag_override,
        "tag_overrides": existing.tag_overrides,
        "url_liveness": existing.url_liveness,
        "best_match": existing.best_match.model_dump() if existing.best_match else None,
        "all_results": [m.model_dump() for m in existing.all_results],
        "databases_searched": list(existing.databases_searched),
        "scholar_url": existing.scholar_url,
        "google_url": existing.google_url,
    })

    return {"success": True}


_ALLOWED_DECISION_VALUES = {"valid", "citation", "fabricated", None}


@router.post("/verify/decision-override/{pdf_id}/{source_id}")
async def set_decision_override(pdf_id: str, source_id: str, request: DecisionOverrideRequest):
    """Store the user's three-state decision-tag override for a source.

    decision="valid" | "citation" | "fabricated" → force that decision state
    decision=None                                → clear override (use classify_decision)
    """
    if request.decision not in _ALLOWED_DECISION_VALUES:
        raise HTTPException(status_code=400, detail=f"Invalid decision: {request.decision}")
    if pdf_id not in verify_results or source_id not in verify_results[pdf_id]:
        raise HTTPException(status_code=404, detail="Result not found")

    existing = verify_results[pdf_id][source_id]
    existing.decision_tag_override = request.decision
    _save_verify_cache(pdf_id, verify_results[pdf_id])

    await manager.broadcast("verify_source_done", {
        "pdf_id": pdf_id,
        "source_id": source_id,
        "status": existing.status,
        "problem_tags": existing.problem_tags,
        "decision_tag": existing.decision_tag,
        "decision_tag_override": existing.decision_tag_override,
        "tag_overrides": existing.tag_overrides,
        "url_liveness": existing.url_liveness,
        "best_match": existing.best_match.model_dump() if existing.best_match else None,
        "all_results": [m.model_dump() for m in existing.all_results],
        "databases_searched": list(existing.databases_searched),
        "scholar_url": existing.scholar_url,
        "google_url": existing.google_url,
    })

    return {"success": True}


class ScholarCandidate(BaseModel):
    title: str
    authors: list[str] = []
    year: int | None = None
    doi: str | None = None
    url: str = ""
    apa_citation: str = ""
    scraped_truncated: bool = False
    cid: str = ""


class ScoreScholarRequest(BaseModel):
    pdf_id: str
    source_id: str
    source_text: str
    candidates: list[ScholarCandidate]


@router.post("/verify/score-scholar")
async def score_scholar(request: ScoreScholarRequest):
    """Score Google Scholar candidates against a source and merge into results."""
    from services.source_extractor import extract_source_fields
    from services.match_scorer import score_match, determine_verification_status, classify_decision
    from services.author_matcher import clean_scholar_authors
    from services.ner_extractor import extract_fields_ner

    # request.source_text is the title-only search query used to hit Scholar.
    # SIRIS NER was trained on full citations and mislabels bare titles — it
    # thinks the leading capitalized words are authors. Use the stored full
    # PDF source text (same as Crossref/OpenAlex paths do) to keep both
    # sides of the comparison symmetric.
    sources = load_sources_for_pdf(request.pdf_id) or []
    source_rect = next((s for s in sources if s.id == request.source_id), None)
    full_source_text = source_rect.text if source_rect else request.source_text

    parsed = await extract_source_fields(full_source_text)

    scholar_matches: list[MatchResult] = []
    search_url = build_search_url("Google Scholar", request.source_text[:200])

    for cand in request.candidates:
        # If we have an APA citation from Scholar's "Cite" dialog, run it
        # through the same NER extractor used on source sources. Scraped
        # Scholar fields truncate title/authors ("J Smith, A Jones…"); the
        # APA string contains the full metadata. Falling through to scraped
        # values preserves behaviour when enrichment fails (CAPTCHA on the
        # cite dialog, low-confidence NER output, etc.).
        title = cand.title
        authors = cand.authors
        year = cand.year
        doi = cand.doi
        journal = ""
        if cand.apa_citation:
            ner = await extract_fields_ner(cand.apa_citation)
            if ner is not None and ner.parse_confidence >= LOW_PARSE_CONFIDENCE_THRESHOLD:
                if ner.title:
                    title = ner.title
                if ner.authors:
                    authors = ner.authors
                if ner.year:
                    year = ner.year
                if ner.doi:
                    doi = ner.doi
                if ner.journal:
                    journal = ner.journal

        match = score_match(parsed, {
            "title": title,
            "authors": clean_scholar_authors(authors),
            "year": year,
            "doi": doi,
            "url": cand.url,
            "journal": journal,
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
        # Keep only the best Scholar candidate, mirroring how every other
        # verifier returns a single MatchResult. Replace any prior Scholar
        # entries so re-runs (e.g. CAPTCHA retry) don't duplicate.
        best_scholar = max(scholar_matches, key=lambda m: m.score)
        existing.all_results = [m for m in existing.all_results if m.database != "Google Scholar"]
        existing.all_results.append(best_scholar)
        if existing.best_match is None or best_scholar.score > existing.best_match.score:
            existing.best_match = best_scholar
        existing.all_results.sort(key=lambda m: m.score, reverse=True)

    # Re-determine status with potentially new best match
    status, problem_tags = determine_verification_status(
        parsed, existing.best_match, existing.url_liveness
    )
    decision_tag = classify_decision(parsed, existing.best_match)
    existing.status = status
    existing.problem_tags = problem_tags
    existing.decision_tag = decision_tag

    # Persist and broadcast
    _save_verify_cache(request.pdf_id, verify_results[request.pdf_id])

    await manager.broadcast("verify_source_done", {
        "pdf_id": request.pdf_id,
        "source_id": request.source_id,
        "status": status,
        "problem_tags": problem_tags,
        "decision_tag": decision_tag,
        "decision_tag_override": existing.decision_tag_override,
        "tag_overrides": existing.tag_overrides,
        "url_liveness": existing.url_liveness,
        "best_match": existing.best_match.model_dump() if existing.best_match else None,
        "all_results": [m.model_dump() for m in existing.all_results],
        "databases_searched": list(existing.databases_searched),
        "scholar_url": existing.scholar_url,
        "google_url": existing.google_url,
    })

    # Recalculate and broadcast PDF counts
    results = verify_results[request.pdf_id]
    high = sum(1 for r in results.values() if r.status == "high")
    medium = sum(1 for r in results.values() if r.status == "medium")
    low = sum(1 for r in results.values() if r.status == "low")

    await manager.broadcast("verify_pdf_updated", {
        "pdf_id": request.pdf_id,
        "high": high,
        "medium": medium,
        "low": low,
    })

    return {
        "updated": True,
        "result": existing.model_dump(),
    }
