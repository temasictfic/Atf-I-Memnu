"""OpenAIRE Graph API v2 verifier — European open-science aggregator.

Covers research products from OpenAIRE's harvested network of repositories,
open-access journals, and data sources (OpenAlex-like coverage with a European
and green-OA bias). No API key required.
"""

from typing import Any
from urllib.parse import quote

import aiohttp

from models.source import ParsedSource
from models.verification_result import MatchResult
from scrapers.rate_limiter import rate_limiter
from services.match_scorer import score_match
from services.openaire_token_manager import get_access_token
from services.scoring_constants import DOI_MATCH_MIN_SCORE
from verifiers._http import check_parked_url, check_rate_limit, get_session

OPENAIRE_API = "https://api.openaire.eu/graph/v2/researchProducts"
_HOST = "api.openaire.eu"

# Authenticated OpenAIRE users get 7,200 req/hour — a safe per-request
# cadence of 0.5 s (2 req/s) leaves ample headroom. Anonymous users cap
# at 60 req/hour, which simple inter-request pacing can't enforce; for
# that case we leave the host-level default (1.0 s) in charge and let
# 429-park cycles average us under the hour window.
_AUTHENTICATED_PACE_SECONDS = 0.5


def _openaire_pace_seconds() -> float | None:
    """Return a per-request pace override when the user is authenticated.

    Mirrors the Crossref polite-pool pattern: when a refresh token is
    configured in settings, the verifier's request will carry a Bearer
    header and qualify for the authenticated rate tier, so we can cadence
    almost 2× faster than the limiter's anonymous-safe default.
    """
    try:
        from api.settings import get_current_settings
        if (get_current_settings().api_keys.get("openaire", "") or "").strip():
            return _AUTHENTICATED_PACE_SECONDS
    except Exception:
        pass
    return None


async def search(source: ParsedSource) -> MatchResult | None:
    """Search OpenAIRE by DOI first, then by title."""
    session = get_session()

    # Priority 1: DOI via persistent identifier filter (pid covers DOI, PMID, etc.)
    if source.doi:
        result = await _fetch_best_match(session, {"pid": source.doi, "pageSize": "5"}, source)
        if result and result.score >= DOI_MATCH_MIN_SCORE:
            return result

    # Priority 2: Title search. `mainTitle` is the structured title filter on v2.
    query = source.title
    if not query:
        return None

    params: dict[str, str] = {
        "mainTitle": query,
        "type": "publication",
        "pageSize": "5",
    }

    # Year range ±1 disambiguates editions without blocking the common
    # print-vs-online date drift.
    if source.year:
        params["fromPublicationDate"] = f"{source.year - 1}-01-01"
        params["toPublicationDate"] = f"{source.year + 1}-12-31"

    best = await _fetch_best_match(session, params, source)
    # Retry without the year window if it filtered out every candidate.
    if best is None and "fromPublicationDate" in params:
        params_no_year = {
            k: v for k, v in params.items()
            if k not in {"fromPublicationDate", "toPublicationDate"}
        }
        best = await _fetch_best_match(session, params_no_year, source)

    return best


async def _fetch_best_match(
    session: aiohttp.ClientSession,
    params: dict[str, str],
    source: ParsedSource,
) -> MatchResult | None:
    """Execute one OpenAIRE request and return the highest-scoring candidate.

    When the user has connected a personal refresh token, we attach the
    exchanged access token to lift the per-IP rate limit from 60 req/hour
    (anonymous) to 7,200 req/hour. A missing or broken token silently falls
    back to anonymous so a bad paste never breaks verification.
    """
    check_parked_url(OPENAIRE_API)
    await rate_limiter.acquire(_HOST, rate=_openaire_pace_seconds())
    access_token = await get_access_token()
    headers = (
        {"Authorization": f"Bearer {access_token}"} if access_token else None
    )
    async with session.get(OPENAIRE_API, params=params, headers=headers) as resp:
        check_rate_limit(resp)
        if resp.status != 200:
            return None
        data = await resp.json()
        results = data.get("results", []) or []

        best: MatchResult | None = None
        for item in results[:5]:
            match = _item_to_match(item, source)
            if match and (best is None or match.score > best.score):
                best = match
        return best


def _item_to_match(item: dict[str, Any], source: ParsedSource) -> MatchResult | None:
    title = item.get("mainTitle", "") or ""

    # authors: list of {fullName, name, surname, rank, pid?}
    authors: list[str] = []
    for author in item.get("authors", []) or []:
        if not isinstance(author, dict):
            continue
        name = author.get("fullName") or author.get("name") or author.get("surname") or ""
        if name:
            authors.append(name)

    # publicationDate: "YYYY-MM-DD"
    year = None
    pub_date = item.get("publicationDate") or ""
    if pub_date:
        try:
            year = int(str(pub_date)[:4])
        except (ValueError, TypeError):
            pass

    # DOI lives in pids as [{scheme: "doi", value: ...}]
    doi = ""
    for pid in item.get("pids", []) or []:
        if not isinstance(pid, dict):
            continue
        if (pid.get("scheme") or "").lower() == "doi" and pid.get("value"):
            doi = pid["value"]
            break

    # container: {name, issnPrinted, issnOnline, volume, issue, sp, ep}
    container = item.get("container") or {}
    journal = container.get("name", "") if isinstance(container, dict) else ""

    # Prefer DOI URL, then the first instance URL.
    url = f"https://doi.org/{doi}" if doi else ""
    if not url:
        for instance in item.get("instances", []) or []:
            urls = instance.get("urls") if isinstance(instance, dict) else None
            if isinstance(urls, list) and urls:
                url = urls[0]
                break

    search_query = source.title or (source.raw_text[:100] if source.raw_text else "")
    candidate = {
        "database": "OpenAIRE",
        "title": title,
        "authors": authors,
        "year": year,
        "doi": doi,
        "journal": journal,
        "url": url,
        "search_url": f"https://explore.openaire.eu/search/find?fv0={quote(search_query)}&f0=q",
    }

    return score_match(source, candidate)
