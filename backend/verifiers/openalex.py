"""OpenAlex API verifier - free, comprehensive academic search."""

from typing import Any
from urllib.parse import quote

import aiohttp

from models.source import ParsedSource
from models.verification_result import MatchResult
from services.match_scorer import score_match
from verifiers._http import get_session

OPENALEX_API = "https://api.openalex.org/works"


async def search(source: ParsedSource, api_key: str | None = None) -> MatchResult | None:
    """Search OpenAlex by title only.

    Title-only queries produce better, more targeted results.  The extracted
    fields (authors, year, journal) are used for *scoring*, not querying.
    A ±1-year publication-date filter is added when the source year is known.
    Optional ``api_key`` is used as the ``mailto`` parameter for polite pool access.
    """
    query = source.title
    if not query:
        return None

    params: dict[str, str] = {
        "search": query,
        "per_page": "5",
        "mailto": api_key or "atfimemnu@example.com",
    }

    # Year-range filter: keeps only works published within ±1 year of the
    # citation year, which is usually enough to exclude other editions.
    if source.year:
        params["filter"] = (
            f"from_publication_date:{source.year - 1}-01-01,"
            f"to_publication_date:{source.year + 1}-12-31"
        )

    session = get_session()
    best = await _fetch_best_match(session, params, source)

    # If the year filter produced nothing (e.g. mis-parsed year),
    # retry without it so we don't silently miss the correct paper.
    if best is None and "filter" in params:
        params_no_filter = {k: v for k, v in params.items() if k != "filter"}
        best = await _fetch_best_match(session, params_no_filter, source)

    return best


async def _fetch_best_match(
    session: aiohttp.ClientSession,
    params: dict[str, str],
    source: ParsedSource,
) -> MatchResult | None:
    """Execute one OpenAlex request and return the highest-scoring match."""
    async with session.get(OPENALEX_API, params=params) as resp:
        if resp.status != 200:
            return None
        data = await resp.json()
        results = data.get("results", [])

        best: MatchResult | None = None
        for item in results[:5]:
            match = _item_to_match(item, source)
            if match and (best is None or match.score > best.score):
                best = match
        return best


def _item_to_match(item: dict[str, Any], source: ParsedSource) -> MatchResult | None:
    title = item.get("display_name", "") or item.get("title", "")

    authors = []
    for authorship in item.get("authorships", []):
        author = authorship.get("author", {})
        name = author.get("display_name", "")
        if name:
            authors.append(name)

    year = item.get("publication_year")
    doi = (item.get("doi") or "").replace("https://doi.org/", "")

    journal = ""
    primary_location = item.get("primary_location", {}) or {}
    source_info = primary_location.get("source", {}) or {}
    journal = source_info.get("display_name", "")

    # Prefer the publisher landing page over the opaque OpenAlex work ID.
    url = (
        primary_location.get("landing_page_url", "")
        or (f"https://doi.org/{doi}" if doi else "")
        or str(item.get("id", ""))
    )

    search_query = source.raw_text[:100] if source.raw_text else (source.title or "")
    candidate = {
        "database": "OpenAlex",
        "title": title,
        "authors": authors,
        "year": year,
        "doi": doi,
        "journal": journal,
        "url": url,
        "search_url": f"https://openalex.org/works?search={quote(search_query)}",
    }

    return score_match(source, candidate)
