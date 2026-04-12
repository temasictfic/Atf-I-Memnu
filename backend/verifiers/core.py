"""CORE API verifier - world's largest collection of open access research.

CORE aggregates 300M+ open access articles and metadata from repositories
and journals worldwide. Requires a free API key from https://core.ac.uk.
"""

import aiohttp
from urllib.parse import quote

from models.source import ParsedSource
from models.verification_result import MatchResult
from services.match_scorer import score_match
from verifiers._http import get_session

CORE_API = "https://api.core.ac.uk/v3/search/works"


async def search(source: ParsedSource, api_key: str | None = None) -> MatchResult | None:
    """Search CORE by title (or DOI if available).

    Errors propagate to the orchestrator so they're surfaced as
    ``db_status: "error"`` instead of being masked as ``not_found``.
    """
    if not api_key:
        return None

    session = get_session()
    # Priority 1: DOI lookup
    if source.doi:
        result = await _search_query(session, f'doi:"{source.doi}"', source, api_key)
        if result and result.score >= 0.5:
            return result

    # Priority 2: Title search
    query = source.title
    if not query:
        return None

    return await _search_query(session, f'title:"{query}"', source, api_key)


async def _search_query(
    session: aiohttp.ClientSession,
    query: str,
    source: ParsedSource,
    api_key: str,
) -> MatchResult | None:
    """Execute a CORE API search and return the best match."""
    headers = {
        "Authorization": f"Bearer {api_key}",
    }
    params = {
        "q": query,
        "limit": "5",
    }

    async with session.get(CORE_API, params=params, headers=headers) as resp:
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


def _item_to_match(item: dict, source: ParsedSource) -> MatchResult | None:
    title = item.get("title", "")

    # Authors come as list of dicts with "name" key
    author_list = item.get("authors", [])
    authors = [a.get("name", "") for a in author_list if isinstance(a, dict) and a.get("name")]

    year = None
    year_published = item.get("yearPublished")
    if year_published:
        try:
            year = int(year_published)
        except (ValueError, TypeError):
            pass

    doi = item.get("doi", "") or ""
    journal = ""
    if item.get("journals"):
        journals = item["journals"]
        if isinstance(journals, list) and journals:
            journal = journals[0].get("title", "") if isinstance(journals[0], dict) else ""

    # Build URL
    core_id = item.get("id", "")
    url = f"https://core.ac.uk/works/{core_id}" if core_id else ""

    search_query = source.title or source.raw_text[:100]
    candidate = {
        "database": "CORE",
        "title": title,
        "authors": authors,
        "year": year,
        "doi": doi,
        "journal": journal,
        "url": url,
        "search_url": f"https://core.ac.uk/search?q={quote(search_query)}",
    }

    return score_match(source, candidate)
