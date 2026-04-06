"""Semantic Scholar API verifier."""

from typing import Any
from urllib.parse import quote

import aiohttp

from models.source import ParsedSource
from models.verification_result import MatchResult
from services.match_scorer import score_match
from services.search_settings import get_client_timeout

API_URL = "https://api.semanticscholar.org/graph/v1/paper/search"


async def search(source: ParsedSource, api_key: str | None = None) -> MatchResult | None:
    """Search Semantic Scholar by title only.

    Title-only queries produce better, more targeted results.  The extracted
    fields (authors, year, journal) are used for *scoring*, not querying.
    The ``year`` parameter restricts results to a ±1-year window when known.
    Optional ``api_key`` adds an ``x-api-key`` header for higher rate limits.
    """
    query = source.title
    if not query:
        return None

    params: dict[str, str] = {
        "query": query,
        "limit": "5",
        "fields": "title,authors,year,externalIds,url,venue",
    }

    # Semantic Scholar Graph API supports year=YYYY-YYYY range filtering.
    if source.year:
        params["year"] = f"{source.year - 1}-{source.year + 1}"

    headers: dict[str, str] = {}
    if api_key:
        headers["x-api-key"] = api_key

    try:
        async with aiohttp.ClientSession(timeout=get_client_timeout()) as session:
            best = await _fetch_best_match(session, params, source, headers)

            # Retry without year filter if it produced nothing.
            if best is None and "year" in params:
                params_no_year = {k: v for k, v in params.items() if k != "year"}
                best = await _fetch_best_match(session, params_no_year, source, headers)

            return best
    except Exception:
        return None


async def _fetch_best_match(
    session: aiohttp.ClientSession,
    params: dict[str, str],
    source: ParsedSource,
    headers: dict[str, str] | None = None,
) -> MatchResult | None:
    """Execute one S2 request and return the highest-scoring match."""
    try:
        async with session.get(API_URL, params=params, headers=headers or {}) as resp:
            if resp.status != 200:
                return None
            data = await resp.json()
            papers = data.get("data", [])

            best: MatchResult | None = None
            for paper in papers[:5]:
                match = _paper_to_match(paper, source)
                if match and (best is None or match.score > best.score):
                    best = match
            return best
    except Exception:
        return None


def _paper_to_match(paper: dict[str, Any], source: ParsedSource) -> MatchResult | None:
    title = paper.get("title", "")
    authors = [a.get("name", "") for a in paper.get("authors", []) if a.get("name")]
    year = paper.get("year")

    ext_ids = paper.get("externalIds", {}) or {}
    doi = ext_ids.get("DOI", "")

    # Prefer a DOI-based URL (direct paper link) over the S2 paper page.
    url = f"https://doi.org/{doi}" if doi else paper.get("url", "")

    search_query = source.raw_text[:100] if source.raw_text else (source.title or "")
    candidate = {
        "database": "Semantic Scholar",
        "title": title,
        "authors": authors,
        "year": year,
        "doi": doi,
        "journal": paper.get("venue", ""),
        "url": url,
        "search_url": f"https://www.semanticscholar.org/search?q={quote(search_query)}",
    }

    return score_match(source, candidate)
