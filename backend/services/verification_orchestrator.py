"""Orchestrate parallel verification of sources across multiple academic databases."""

import asyncio
import inspect
import re
from typing import Any
from urllib.parse import quote, quote_plus

from api.websocket import manager
from models.settings import DatabaseConfig
from models.source import SourceRectangle, ParsedSource
from models.verification_result import VerificationResult, MatchResult
from services.match_scorer import determine_status
from services.search_settings import (
    get_max_concurrent_apis,
    get_max_concurrent_sources_per_pdf,
    get_search_timeout_seconds,
)
from services.source_extractor import extract_source_fields
from verifiers.base import CaptchaError, BlockedError


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
        "DuckDuckGo": f"https://duckduckgo.com/?q={quote(query)}",
    }
    return urls.get(db_name, "")


def _supports_api_key_argument(search_fn: Any) -> bool:
    """Check whether a verifier accepts an ``api_key`` keyword argument."""
    try:
        return "api_key" in inspect.signature(search_fn).parameters
    except (TypeError, ValueError):
        return False


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

    async def verify_with_limit(source: SourceRectangle):
        async with source_semaphore:
            await _verify_source(pdf_id, source, results_store)

    # Create tasks and register for cancellation
    asyncio_tasks = [asyncio.create_task(verify_with_limit(s)) for s in sources]
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
        green = sum(1 for r in results.values() if r.status == "green")
        yellow = sum(1 for r in results.values() if r.status == "yellow")
        red = sum(1 for r in results.values() if r.status == "red")
        black = sum(1 for r in results.values() if r.status == "black")

        await manager.broadcast("verify_pdf_done", {
            "pdf_id": pdf_id,
            "green": green,
            "yellow": yellow,
            "red": red,
            "black": black,
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
        await _verify_source(pdf_id, temp_source, results_store)
    except asyncio.CancelledError:
        pass
    finally:
        _unregister_key(source_id)

    # Recalculate counts
    results = results_store.get(pdf_id, {})
    green = sum(1 for r in results.values() if r.status == "green")
    yellow = sum(1 for r in results.values() if r.status == "yellow")
    red = sum(1 for r in results.values() if r.status == "red")
    black = sum(1 for r in results.values() if r.status == "black")

    await manager.broadcast("verify_pdf_updated", {
        "pdf_id": pdf_id,
        "green": green,
        "yellow": yellow,
        "red": red,
        "black": black,
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
):
    """Verify a single source against all databases."""
    source_id = source.id

    # Initialize result
    results_store[pdf_id][source_id] = VerificationResult(
        source_id=source_id,
        status="in_progress",
    )

    await manager.broadcast("verify_started", {
        "pdf_id": pdf_id,
        "source_id": source_id,
        "source_text": source.text[:200],
    })

    all_matches: list[MatchResult] = []
    databases_searched: list[str] = []

    try:
        # Load settings for API keys and enabled databases
        from api.settings import get_current_settings
        app_settings = get_current_settings()
        api_keys = app_settings.api_keys
        enabled_db_configs = {db.id: db for db in app_settings.databases if db.enabled}
        search_timeout = get_search_timeout_seconds()
        api_semaphore = asyncio.Semaphore(get_max_concurrent_apis())

        # Parse source text into structured fields
        parsed = extract_source_fields(source.text)

        if parsed.doi:
            await manager.send_log("info", f"DOI found: {parsed.doi}", pdf_id=pdf_id, source_id=source_id)

        if parsed.citation_format:
            await manager.send_log("info", f"Format: {parsed.citation_format}", pdf_id=pdf_id, source_id=source_id)

        # Kurallar General Note: non-conforming references fall back to raw text search
        if parsed.parse_confidence < 0.3:
            await manager.send_log(
                "warning",
                f"Low parse confidence ({parsed.parse_confidence:.2f}), using raw text search",
                pdf_id=pdf_id,
                source_id=source_id,
            )
            # Use cleaned raw text as title for broader search queries
            cleaned = re.sub(r"^\s*\[?\d{1,3}\]?[.\)]\s*", "", source.text).strip()
            # Remove URLs and DOIs from the search query
            cleaned = re.sub(r"https?://\S+", "", cleaned)
            cleaned = re.sub(r"doi[:\s]*10\.\S+", "", cleaned, flags=re.IGNORECASE)
            parsed.title = cleaned[:200].strip()

        # Phase 1: Tier 1 APIs (parallel)
        tier1_results = await _run_tier1_apis(
            pdf_id,
            source_id,
            parsed,
            api_keys,
            enabled_db_configs,
            api_semaphore,
            search_timeout,
        )
        all_matches.extend(tier1_results["matches"])
        databases_searched.extend(tier1_results["searched"])

        # Check if we have a green match already
        best_score = max((m.score for m in all_matches), default=0)
        if best_score >= 0.65:
            return

        # Phase 2: Tier 2 Meta-search fallback (DuckDuckGo)
        tier2_results = await _run_tier2_fallback(
            pdf_id,
            source_id,
            parsed,
            enabled_db_configs,
            api_semaphore,
            search_timeout,
        )
        all_matches.extend(tier2_results["matches"])
        databases_searched.extend(tier2_results["searched"])

    except asyncio.CancelledError:
        await manager.send_log("info", f"Source {source_id} verification cancelled",
                              pdf_id=pdf_id, source_id=source_id)
    except Exception as e:
        await manager.send_log("error", f"Source {source_id} verification error: {e}",
                              pdf_id=pdf_id, source_id=source_id)
    finally:
        # Always finalize — guarantees verify_source_done is sent
        await _finalize_result(results_store, pdf_id, source_id, all_matches, databases_searched)


async def _run_tier1_apis(
    pdf_id: str,
    source_id: str,
    parsed: ParsedSource,
    api_keys: dict[str, str],
    enabled_db_configs: dict[str, DatabaseConfig],
    api_semaphore: asyncio.Semaphore,
    search_timeout: int,
) -> dict[str, Any]:
    """Run all Tier 1 API verifiers in parallel."""
    from verifiers.crossref import search as crossref_search
    from verifiers.openalex import search as openalex_search
    from verifiers.arxiv import search as arxiv_search
    from verifiers.semantic_scholar import search as semantic_search
    from verifiers.europe_pmc import search as europe_pmc_search
    from verifiers.trdizin import search as trdizin_search

    # (settings database id, display name, search function)
    all_verifiers = [
        ("crossref", "Crossref", crossref_search),
        ("openalex", "OpenAlex", openalex_search),
        ("arxiv", "arXiv", arxiv_search),
        ("semantic_scholar", "Semantic Scholar", semantic_search),
        ("europe_pmc", "Europe PMC", europe_pmc_search),
        ("trdizin", "TRDizin", trdizin_search),
    ]
    verifiers = [
        (db_id, display_name, fn)
        for db_id, display_name, fn in all_verifiers
        if db_id in enabled_db_configs
    ]

    matches: list[MatchResult] = []
    searched: list[str] = []

    async def run_verifier(db_id: str, name: str, search_fn: Any):
        async with api_semaphore:
            fallback_url = _build_search_url(name, parsed)
            api_key_names = {
                "openalex": "openalex",
                "semantic_scholar": "semantic_scholar",
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

            except CaptchaError:
                searched.append(name)
                await manager.send_log("warning", f"{name} blocked by CAPTCHA",
                                      pdf_id=pdf_id, source_id=source_id, database=name)
                await manager.broadcast("verify_db_checked", {
                    "pdf_id": pdf_id,
                    "source_id": source_id,
                    "database": name,
                    "found": False,
                    "db_status": "captcha",
                    "search_url": fallback_url,
                })
            except BlockedError:
                searched.append(name)
                await manager.send_log("warning", f"{name} access blocked",
                                      pdf_id=pdf_id, source_id=source_id, database=name)
                await manager.broadcast("verify_db_checked", {
                    "pdf_id": pdf_id,
                    "source_id": source_id,
                    "database": name,
                    "found": False,
                    "db_status": "blocked",
                    "search_url": fallback_url,
                })
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

    await asyncio.gather(
        *[run_verifier(db_id, name, fn) for db_id, name, fn in verifiers],
        return_exceptions=True,
    )

    return {"matches": matches, "searched": searched}


async def _run_tier2_fallback(
    pdf_id: str,
    source_id: str,
    parsed: ParsedSource,
    enabled_db_configs: dict[str, DatabaseConfig],
    api_semaphore: asyncio.Semaphore,
    search_timeout: int,
) -> dict[str, Any]:
    """Run Tier 2 meta-search engine as final fallback (DuckDuckGo)."""
    if "duckduckgo" not in enabled_db_configs:
        return {"matches": [], "searched": []}

    from verifiers.meta_search import search_duckduckgo

    matches: list[MatchResult] = []
    searched: list[str] = []

    async with api_semaphore:
        fallback_url = _build_search_url("DuckDuckGo", parsed)
        try:
            await manager.broadcast("verify_db_checking", {
                "pdf_id": pdf_id, "source_id": source_id, "database": "DuckDuckGo",
            })
            result = await asyncio.wait_for(search_duckduckgo(parsed), timeout=search_timeout)
            searched.append("DuckDuckGo")
            found = result is not None and result.score >= 0.5

            await manager.broadcast("verify_db_checked", {
                "pdf_id": pdf_id,
                "source_id": source_id,
                "database": "DuckDuckGo",
                "found": found,
                "match": result.model_dump() if result else None,
                "db_status": "found" if found else "not_found",
                "search_url": (result.search_url if result else None) or fallback_url,
            })

            if result and result.score > 0:
                matches.append(result)
        except asyncio.TimeoutError:
            searched.append("DuckDuckGo")
            await manager.send_log("warning", "DuckDuckGo timed out",
                                  pdf_id=pdf_id, source_id=source_id, database="DuckDuckGo")
            await manager.broadcast("verify_db_checked", {
                "pdf_id": pdf_id, "source_id": source_id, "database": "DuckDuckGo",
                "found": False, "db_status": "timeout", "search_url": fallback_url,
            })
        except Exception as e:
            searched.append("DuckDuckGo")
            await manager.send_log("warning", f"DuckDuckGo search failed: {e}",
                                  pdf_id=pdf_id, source_id=source_id, database="DuckDuckGo")
            await manager.broadcast("verify_db_checked", {
                "pdf_id": pdf_id, "source_id": source_id, "database": "DuckDuckGo",
                "found": False, "db_status": "error",
                "error_message": str(e)[:200], "search_url": fallback_url,
            })

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
            modified.append(s.model_copy(update={"text": custom_texts[s.id]}))
        else:
            modified.append(s)

    await verify_pdf_sources(pdf_id, modified, results_store)


async def _finalize_result(
    results_store: dict,
    pdf_id: str,
    source_id: str,
    all_matches: list[MatchResult],
    databases_searched: list[str],
):
    """Finalize the verification result for a source."""
    best_match = max(all_matches, key=lambda m: m.score) if all_matches else None
    best_score = best_match.score if best_match else 0.0
    status = determine_status(best_score)

    result = VerificationResult(
        source_id=source_id,
        status=status,
        best_match=best_match,
        all_results=sorted(all_matches, key=lambda m: m.score, reverse=True),
        databases_searched=databases_searched,
    )
    results_store[pdf_id][source_id] = result

    await manager.broadcast("verify_source_done", {
        "pdf_id": pdf_id,
        "source_id": source_id,
        "status": status,
        "best_match": best_match.model_dump() if best_match else None,
        "all_results": [m.model_dump() for m in result.all_results],
    })
