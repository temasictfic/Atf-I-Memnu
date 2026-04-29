"""Semantic Scholar API verifier."""

from typing import Any
from urllib.parse import quote

import aiohttp

from models.source import ParsedSource
from models.verification_result import MatchResult
from scrapers.rate_limiter import rate_limiter
from services.match_scorer import score_match
from verifiers._http import check_parked_url, check_rate_limit, fetch_with_year_fallback, get_session

API_URL = "https://api.semanticscholar.org/graph/v1/paper/search"
_HOST = "api.semanticscholar.org"


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
        "fields": "title,authors,year,externalIds,url,venue,journal,publicationTypes",
    }

    # Semantic Scholar Graph API supports year=YYYY-YYYY range filtering.
    if source.year:
        params["year"] = f"{source.year - 1}-{source.year + 1}"

    headers: dict[str, str] = {}
    if api_key:
        headers["x-api-key"] = api_key

    session = get_session()
    return await fetch_with_year_fallback(
        lambda p: _fetch_best_match(session, p, source, headers),
        params,
        {"year"},
    )


async def _fetch_best_match(
    session: aiohttp.ClientSession,
    params: dict[str, str],
    source: ParsedSource,
    headers: dict[str, str] | None = None,
) -> MatchResult | None:
    """Execute one S2 request and return the highest-scoring match."""
    check_parked_url(API_URL)
    await rate_limiter.acquire(_HOST)
    async with session.get(API_URL, params=params, headers=headers or {}) as resp:
        check_rate_limit(resp)
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


def _paper_to_match(paper: dict[str, Any], source: ParsedSource) -> MatchResult | None:
    title = paper.get("title", "")
    authors = [a.get("name", "") for a in paper.get("authors", []) if a.get("name")]
    year = paper.get("year")

    ext_ids = paper.get("externalIds", {}) or {}
    doi = ext_ids.get("DOI", "")

    # Prefer a DOI-based URL (direct paper link) over the S2 paper page.
    url = f"https://doi.org/{doi}" if doi else paper.get("url", "")

    journal_obj = paper.get("journal") or {}
    if not isinstance(journal_obj, dict):
        journal_obj = {}
    volume = journal_obj.get("volume") or None
    pages = journal_obj.get("pages") or None

    pub_types = paper.get("publicationTypes") or []
    document_type = ""
    if isinstance(pub_types, list) and pub_types:
        document_type = str(pub_types[0]) if pub_types[0] else ""

    search_query = source.title or (source.raw_text[:100] if source.raw_text else "")
    candidate = {
        "database": "Semantic Scholar",
        "title": title,
        "authors": authors,
        "year": year,
        "doi": doi,
        "journal": paper.get("venue", ""),
        "url": url,
        "search_url": f"https://www.semanticscholar.org/search?q={quote(search_query)}",
        "volume": volume,
        "pages": pages,
        "document_type": document_type,
    }

    return score_match(source, candidate)
