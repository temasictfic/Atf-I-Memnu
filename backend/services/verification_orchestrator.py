"""Orchestrate parallel verification of sources across multiple academic databases."""

import asyncio
import inspect
from typing import Any
from urllib.parse import quote, quote_plus

from api.websocket import manager
from models.settings import DatabaseConfig
from models.source import SourceRectangle, ParsedSource
from models.verification_result import VerificationResult, MatchResult
from services.match_scorer import determine_verification_status
from services.search_settings import (
    get_max_concurrent_apis,
    get_max_concurrent_sources_per_pdf,
    get_search_timeout_seconds,
)
from services.source_extractor import extract_source_fields
from services.url_checker import check_urls, is_doi_or_arxiv_url
from utils.text_cleaning import strip_reference_noise
from verifiers._http import RateLimitedError


# --- Cancellation registry ---
# Maps key (pdf_id or source_id) to list of asyncio.Task objects.
# Cancelling = calling .cancel() on the tasks for immediate interruption.
_active_tasks: dict[str, list[asyncio.Task]] = {}


def request_cancel(key: str) -> None:
    """Cancel all tasks associated with a key (pdf_id or source_id)."""
    for task in _active_tasks.get(key, []):
        task.cancel()


def cancel_all_active() -> None:
    """Cancel all running verification tasks."""
    for tasks in _active_tasks.values():
        for task in tasks:
            task.cancel()


def _register_task(key: str, task: asyncio.Task) -> None:
    _active_tasks.setdefault(key, []).append(task)


def _unregister_key(key: str) -> None:
    _active_tasks.pop(key, None)


def _build_search_url(db_name: str, parsed: ParsedSource) -> str:
    """Build a manual search URL for a given database."""
    query = parsed.title or parsed.raw_text[:200]
    urls = {
        "Crossref": f"https://search.crossref.org/search/works?q={quote_plus(query)}&from_ui=yes",
        "OpenAlex": f"https://openalex.org/works?search={quote(query)}",
        "arXiv": f"https://arxiv.org/search/?query={quote(query)}&searchtype=all",
        "Semantic Scholar": f"https://www.semanticscholar.org/search?q={quote(query)}",
        "Europe PMC": f"https://europepmc.org/search?query={quote(query)}",
        "TRDizin": f"https://search.trdizin.gov.tr/tr/yayin/ara?q={quote(query, safe=',')}&order=publicationYear-DESC&page=1&limit=20",
        "PubMed": f"https://pubmed.ncbi.nlm.nih.gov/?term={quote(query)}",
        "CORE": f"https://core.ac.uk/search?q={quote(query)}",
        "PLOS": f"https://journals.plos.org/plosone/search?q={quote(query)}",
        "Open Library": f"https://openlibrary.org/search?q={quote(query)}",
    }
    return urls.get(db_name, "")


def _supports_api_key_argument(search_fn: Any) -> bool:
    """Check whether a verifier accepts an ``api_key`` keyword argument."""
    try:
        return "api_key" in inspect.signature(search_fn).parameters
    except (TypeError, ValueError):
        return False


def _is_strong_match(result: MatchResult | None) -> bool:
    """Return True when a single verifier's result is strong enough to
    cancel the remaining parallel verifiers for this source.

    Only triggers on a rock-solid signal: composite score ≥ 0.95 *and* a
    URL/DOI/arXiv-ID match from the match_scorer. That combination is
    almost exclusive to DOI lookups (or direct arXiv-ID lookups), which
    are the cases where continuing to query 9 more APIs is pure quota
    waste — no other DB is going to improve on a DOI-exact hit. Ambiguous
    references (title-only, editor citations, retracted-era works) stay
    below this threshold and correctly exercise the full verifier fleet.
    """
    if result is None:
        return False
    if result.score < 0.95:
        return False
    return bool(result.match_details.url_match)


async def verify_pdf_sources(
    pdf_id: str,
    sources: list[SourceRectangle],
    results_store: dict[str, dict[str, VerificationResult]],
):
    """Verify all sources for a single PDF."""
    if pdf_id not in results_store:
        results_store[pdf_id] = {}

    await manager.send_log("info", f"Verifying {len(sources)} sources for {pdf_id}", pdf_id=pdf_id)

    source_semaphore = asyncio.Semaphore(get_max_concurrent_sources_per_pdf())

    async def verify_with_limit(source: SourceRectangle, index: int):
        async with source_semaphore:
            await _verify_source(pdf_id, source, results_store, index)

    # Create tasks and register for cancellation
    asyncio_tasks = [asyncio.create_task(verify_with_limit(s, i)) for i, s in enumerate(sources)]
    for t in asyncio_tasks:
        _register_task(pdf_id, t)

    try:
        await asyncio.gather(*asyncio_tasks, return_exceptions=True)
    except asyncio.CancelledError:
        # Cancel all child tasks on cancellation
        for t in asyncio_tasks:
            t.cancel()
        # Wait for children to finish their finally blocks (finalize partial results)
        await asyncio.gather(*asyncio_tasks, return_exceptions=True)
    finally:
        _unregister_key(pdf_id)

        # Calculate final counts (works for both normal and cancelled runs)
        results = results_store.get(pdf_id, {})
        found = sum(1 for r in results.values() if r.status == "found")
        problematic = sum(1 for r in results.values() if r.status == "problematic")
        not_found = sum(1 for r in results.values() if r.status == "not_found")

        await manager.broadcast("verify_pdf_done", {
            "pdf_id": pdf_id,
            "found": found,
            "problematic": problematic,
            "not_found": not_found,
        })

        # Persist results to disk cache
        try:
            from api.verification import _save_verify_cache
            _save_verify_cache(pdf_id, results)
        except Exception:
            pass


async def verify_single_source(
    pdf_id: str,
    source_id: str,
    text: str,
    results_store: dict[str, dict[str, VerificationResult]],
):
    """Verify a single source (used for individual verification)."""
    if pdf_id not in results_store:
        results_store[pdf_id] = {}

    # Create a temporary SourceRectangle-like object
    from models.source import BoundingBox
    temp_source = SourceRectangle(
        id=source_id,
        pdf_id=pdf_id,
        bbox=BoundingBox(x0=0, y0=0, x1=0, y1=0, page=0),
        text=text,
        status="approved",
    )

    try:
        await _verify_source(pdf_id, temp_source, results_store, 0)
    except asyncio.CancelledError:
        pass
    finally:
        _unregister_key(source_id)

    # Recalculate counts
    results = results_store.get(pdf_id, {})
    found = sum(1 for r in results.values() if r.status == "found")
    problematic = sum(1 for r in results.values() if r.status == "problematic")
    not_found = sum(1 for r in results.values() if r.status == "not_found")

    await manager.broadcast("verify_pdf_updated", {
        "pdf_id": pdf_id,
        "found": found,
        "problematic": problematic,
        "not_found": not_found,
    })

    # Persist updated results to disk cache
    try:
        from api.verification import _save_verify_cache
        _save_verify_cache(pdf_id, results)
    except Exception:
        pass


async def _verify_source(
    pdf_id: str,
    source: SourceRectangle,
    results_store: dict[str, dict[str, VerificationResult]],
    source_index: int = 0,
):
    """Verify a single source against all databases."""
    source_id = source.id

    # Initialize result
    results_store[pdf_id][source_id] = VerificationResult(
        source_id=source_id,
        status="in_progress",
    )

    source_text = strip_reference_noise(source.text)

    await manager.broadcast("verify_started", {
        "pdf_id": pdf_id,
        "source_id": source_id,
        "source_text": source_text[:200],
    })

    all_matches: list[MatchResult] = []
    databases_searched: list[str] = []
    parsed: ParsedSource | None = None
    url_liveness: dict[str, bool] = {}
    # Tracked here (not inside `try`) so the `finally` block can reach it
    # even if cancellation lands before we assign inside the try.
    url_check_task: asyncio.Task | None = None

    try:
        # Load settings for API keys and enabled databases
        from api.settings import get_current_settings
        app_settings = get_current_settings()
        api_keys = app_settings.api_keys
        enabled_db_configs = {db.id: db for db in app_settings.databases if db.enabled}
        search_timeout = get_search_timeout_seconds()
        api_semaphore = asyncio.Semaphore(get_max_concurrent_apis())

        # Parse source text into structured fields
        parsed = await extract_source_fields(source_text)

        if parsed.doi:
            await manager.send_log("info", f"DOI found: {parsed.doi}", pdf_id=pdf_id, source_id=source_id)

        if parsed.citation_format:
            await manager.send_log("info", f"Format: {parsed.citation_format}", pdf_id=pdf_id, source_id=source_id)

        # All verifier searches are driven by the NER-extracted title. When the
        # parse confidence is low we warn but do NOT overwrite the title with
        # cleaned raw text — the user has explicitly required that every DB
        # query use the NER title, falling back only when it is genuinely empty.
        if parsed.parse_confidence < 0.3:
            await manager.send_log(
                "warning",
                f"Low parse confidence ({parsed.parse_confidence:.2f}), searching with extracted title only",
                pdf_id=pdf_id,
                source_id=source_id,
            )

        # Kick off URL liveness check in parallel with the database searches.
        # Skips doi.org / arxiv.org URLs (validated via API verifiers).
        urls_to_check: list[str] = []
        if parsed.url and not is_doi_or_arxiv_url(parsed.url):
            urls_to_check.append(parsed.url)
        if urls_to_check:
            url_check_task = asyncio.create_task(check_urls(urls_to_check))

        # Phase 1: Tier 1 APIs (parallel)
        tier1_results = await _run_tier1_apis(
            pdf_id,
            source_id,
            parsed,
            api_keys,
            enabled_db_configs,
            api_semaphore,
            search_timeout,
            source_index,
        )
        all_matches.extend(tier1_results["matches"])
        databases_searched.extend(tier1_results["searched"])

        # Wait for URL check to complete (with bounded timeout)
        if url_check_task is not None:
            try:
                url_liveness = await asyncio.wait_for(url_check_task, timeout=12.0)
            except (asyncio.TimeoutError, Exception):
                url_liveness = {u: False for u in urls_to_check}

    except asyncio.CancelledError:
        await manager.send_log("info", f"Source {source_id} verification cancelled",
                              pdf_id=pdf_id, source_id=source_id)
    except Exception as e:
        await manager.send_log("error", f"Source {source_id} verification error: {e}",
                              pdf_id=pdf_id, source_id=source_id)
    finally:
        # Cancel the fire-and-forget URL liveness check so it stops making
        # HTTP requests as soon as the source-level task is cancelled. Without
        # this, `check_urls` runs to its ~10s timeout in the background even
        # after the user has clicked Stop.
        if url_check_task is not None and not url_check_task.done():
            url_check_task.cancel()
            try:
                await url_check_task
            except (asyncio.CancelledError, Exception):
                pass

        # Always finalize — guarantees verify_source_done is sent
        await _finalize_result(
            results_store, pdf_id, source_id, parsed, all_matches,
            databases_searched, url_liveness,
        )


async def _run_tier1_apis(
    pdf_id: str,
    source_id: str,
    parsed: ParsedSource,
    api_keys: dict[str, str],
    enabled_db_configs: dict[str, DatabaseConfig],
    api_semaphore: asyncio.Semaphore,
    search_timeout: int,
    source_index: int = 0,
) -> dict[str, Any]:
    """Run all Tier 1 API verifiers in parallel."""
    from verifiers.crossref import search as crossref_search
    from verifiers.openalex import search as openalex_search
    from verifiers.arxiv import search as arxiv_search
    from verifiers.semantic_scholar import search as semantic_search
    from verifiers.europe_pmc import search as europe_pmc_search
    from verifiers.trdizin import search as trdizin_search
    from verifiers.pubmed import search as pubmed_search
    from verifiers.core import search as core_search
    from verifiers.plos import search as plos_search
    from verifiers.open_library import search as open_library_search

    # Map database id → (display name, search function)
    verifier_registry = {
        "crossref": ("Crossref", crossref_search),
        "openalex": ("OpenAlex", openalex_search),
        "arxiv": ("arXiv", arxiv_search),
        "semantic_scholar": ("Semantic Scholar", semantic_search),
        "europe_pmc": ("Europe PMC", europe_pmc_search),
        "trdizin": ("TRDizin", trdizin_search),
        "pubmed": ("PubMed", pubmed_search),
        "core": ("CORE", core_search),
        "plos": ("PLOS", plos_search),
        "open_library": ("Open Library", open_library_search),
    }

    # Build verifier list in the order defined by user settings
    verifiers = []
    for db_id in enabled_db_configs:
        entry = verifier_registry.get(db_id)
        if entry:
            verifiers.append((db_id, entry[0], entry[1]))

    # Rotate by source index so concurrent sources start on different DBs,
    # avoiding per-DB rate-limit bursts from lockstep traversal.
    if verifiers:
        offset = source_index % len(verifiers)
        verifiers = verifiers[offset:] + verifiers[:offset]

    matches: list[MatchResult] = []
    searched: list[str] = []

    async def run_verifier(db_id: str, name: str, search_fn: Any):
        fallback_url = _build_search_url(name, parsed)
        try:
            async with api_semaphore:
                api_key_names = {
                    "openalex": "openalex",
                    "semantic_scholar": "semantic_scholar",
                    "pubmed": "pubmed",
                    "core": "core",
                }
                api_key_name = api_key_names.get(db_id)
                api_key = (api_keys.get(api_key_name, "") or "").strip() if api_key_name else None
                try:
                    await manager.broadcast("verify_db_checking", {
                        "pdf_id": pdf_id, "source_id": source_id, "database": name,
                    })

                    if _supports_api_key_argument(search_fn):
                        result = await asyncio.wait_for(
                            search_fn(parsed, api_key=api_key or None),
                            timeout=search_timeout,
                        )
                    else:
                        result = await asyncio.wait_for(search_fn(parsed), timeout=search_timeout)

                    searched.append(name)
                    found = result is not None and result.score >= 0.5

                    await manager.broadcast("verify_db_checked", {
                        "pdf_id": pdf_id,
                        "source_id": source_id,
                        "database": name,
                        "found": found,
                        "match": result.model_dump() if result else None,
                        "db_status": "found" if found else "not_found",
                        "search_url": (result.search_url if result else None) or fallback_url,
                    })

                    if result and result.score > 0:
                        matches.append(result)
                except asyncio.TimeoutError:
                    searched.append(name)
                    await manager.send_log("warning", f"{name} timed out",
                                          pdf_id=pdf_id, source_id=source_id, database=name)
                    await manager.broadcast("verify_db_checked", {
                        "pdf_id": pdf_id,
                        "source_id": source_id,
                        "database": name,
                        "found": False,
                        "db_status": "timeout",
                        "search_url": fallback_url,
                    })
                except RateLimitedError as e:
                    searched.append(name)
                    retry_msg = (
                        f" (retry-after {e.retry_after:.0f}s)"
                        if e.retry_after is not None else ""
                    )
                    await manager.send_log(
                        "warning",
                        f"{name} rate limited{retry_msg}",
                        pdf_id=pdf_id, source_id=source_id, database=name,
                    )
                    await manager.broadcast("verify_db_checked", {
                        "pdf_id": pdf_id,
                        "source_id": source_id,
                        "database": name,
                        "found": False,
                        "db_status": "rate_limited",
                        "retry_after": e.retry_after,
                        "search_url": fallback_url,
                    })
                except Exception as e:
                    searched.append(name)
                    await manager.send_log("warning", f"{name} search failed: {e}",
                                          pdf_id=pdf_id, source_id=source_id, database=name)
                    await manager.broadcast("verify_db_checked", {
                        "pdf_id": pdf_id,
                        "source_id": source_id,
                        "database": name,
                        "found": False,
                        "db_status": "error",
                        "error_message": str(e)[:200],
                        "search_url": fallback_url,
                    })
        except asyncio.CancelledError:
            # Short-circuit cancel: a sibling verifier landed a strong
            # DOI-exact match. Emit a "skipped" event so the UI gets a
            # terminal dot for this db. Handled at the outer level so
            # cancellations while queued on api_semaphore (before the
            # body runs) are covered too — otherwise those tasks would
            # leave empty dots. Shielded so the broadcast completes even
            # as the task is torn down.
            if name not in searched:
                searched.append(name)
                try:
                    await asyncio.shield(manager.broadcast("verify_db_checked", {
                        "pdf_id": pdf_id,
                        "source_id": source_id,
                        "database": name,
                        "found": False,
                        "db_status": "skipped",
                        "search_url": fallback_url,
                    }))
                except Exception:
                    pass
            raise

    # Create all verifier tasks up front, then walk as_completed so we can
    # inspect results as they land and short-circuit when one verifier
    # returns a strong DOI-exact match. Siblings still in flight get
    # cancelled, their CancelledError handlers emit "skipped" dots, and
    # the finally block gathers them so cleanup completes before we
    # return. On ambiguous references no verifier crosses the threshold
    # and every task runs to normal completion, exactly like before.
    tasks = [
        asyncio.create_task(run_verifier(db_id, name, fn))
        for db_id, name, fn in verifiers
    ]
    try:
        for fut in asyncio.as_completed(tasks):
            try:
                await fut
            except asyncio.CancelledError:
                # Re-raised from run_verifier's cancel handler after it
                # emitted the "skipped" event. Swallow here so the
                # as_completed loop keeps progressing.
                pass
            except Exception:
                # Other exceptions are already handled inside run_verifier
                # (they broadcast their own error/timeout/rate_limited
                # events). Don't let them break the as_completed walk.
                pass

            if any(_is_strong_match(m) for m in matches):
                for t in tasks:
                    if not t.done():
                        t.cancel()
                break
    finally:
        # Wait for any still-running tasks (either cancelled short-circuit
        # tasks finishing their cleanup, or the normal-path case where we
        # broke out after the last task) to fully settle.
        await asyncio.gather(*tasks, return_exceptions=True)

    return {"matches": matches, "searched": searched}


async def verify_pdf_sources_filtered(
    pdf_id: str,
    sources: list[SourceRectangle],
    results_store: dict[str, dict[str, VerificationResult]],
    custom_texts: dict[str, str],
    excluded_ids: set[str],
):
    """Verify sources with custom texts and exclusions."""
    filtered = [s for s in sources if s.id not in excluded_ids]

    # Apply custom text overrides
    modified = []
    for s in filtered:
        if s.id in custom_texts:
            modified.append(s.model_copy(update={"text": strip_reference_noise(custom_texts[s.id])}))
        else:
            modified.append(s)

    await verify_pdf_sources(pdf_id, modified, results_store)


async def _finalize_result(
    results_store: dict,
    pdf_id: str,
    source_id: str,
    parsed: ParsedSource | None,
    all_matches: list[MatchResult],
    databases_searched: list[str],
    url_liveness: dict[str, bool] | None = None,
):
    """Finalize the verification result for a source.

    Picks the best candidate by composite score, then runs the new 3-category
    status determination (found / problematic / not_found) with problem tags.
    """
    url_liveness = url_liveness or {}

    # Best candidate is the highest-scoring match (composite of title+author).
    best_match = max(all_matches, key=lambda m: m.score) if all_matches else None

    if parsed is not None:
        status, problem_tags = determine_verification_status(
            parsed, best_match, url_liveness
        )
    else:
        # Failure to parse → fall back to not_found
        status, problem_tags = "not_found", []

    result = VerificationResult(
        source_id=source_id,
        status=status,
        problem_tags=problem_tags,
        url_liveness=url_liveness,
        best_match=best_match,
        all_results=sorted(all_matches, key=lambda m: m.score, reverse=True),
        databases_searched=databases_searched,
    )
    results_store[pdf_id][source_id] = result

    await manager.broadcast("verify_source_done", {
        "pdf_id": pdf_id,
        "source_id": source_id,
        "status": status,
        "problem_tags": problem_tags,
        "url_liveness": url_liveness,
        "best_match": best_match.model_dump() if best_match else None,
        "all_results": [m.model_dump() for m in result.all_results],
        "databases_searched": list(databases_searched),
    })
