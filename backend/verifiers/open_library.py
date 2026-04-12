"""Open Library API verifier - Internet Archive's open book catalog.

Open Library covers 20M+ edition records with strong book/monograph coverage.
No API key required.
"""

import aiohttp
from urllib.parse import quote

from models.source import ParsedSource
from models.verification_result import MatchResult
from services.match_scorer import score_match
from verifiers._http import get_session

SEARCH_API = "https://openlibrary.org/search.json"


async def search(source: ParsedSource) -> MatchResult | None:
    """Search Open Library by ISBN, DOI, or title.

    Errors propagate to the orchestrator so they're surfaced as
    ``db_status: "error"`` rather than silently ``not_found``.
    """
    session = get_session()
    # Priority 1: DOI lookup
    if source.doi:
        result = await _search_query(session, {"q": source.doi}, source)
        if result and result.score >= 0.5:
            return result

    # Priority 2: Title search
    query = source.title
    if not query:
        return None

    return await _search_query(session, {"title": query}, source)


async def _search_query(
    session: aiohttp.ClientSession,
    params: dict[str, str],
    source: ParsedSource,
) -> MatchResult | None:
    """Execute an Open Library search and return the best match."""
    params = {**params, "limit": "5", "fields": "title,author_name,first_publish_year,isbn,key,publisher,subject"}

    async with session.get(SEARCH_API, params=params) as resp:
        if resp.status != 200:
            return None
        data = await resp.json()
        docs = data.get("docs", [])

        best: MatchResult | None = None
        for item in docs[:5]:
            match = _item_to_match(item, source)
            if match and (best is None or match.score > best.score):
                best = match
        return best


def _item_to_match(item: dict, source: ParsedSource) -> MatchResult | None:
    title = item.get("title", "")

    authors = item.get("author_name", [])
    if not isinstance(authors, list):
        authors = []

    year = None
    pub_year = item.get("first_publish_year")
    if pub_year:
        try:
            year = int(pub_year)
        except (ValueError, TypeError):
            pass

    # Open Library doesn't store DOIs directly
    doi = ""

    # Build URL from the work key
    key = item.get("key", "")
    url = f"https://openlibrary.org{key}" if key else ""

    journal = ""
    publishers = item.get("publisher", [])
    if isinstance(publishers, list) and publishers:
        journal = publishers[0]

    search_query = source.title or source.raw_text[:100]
    candidate = {
        "database": "Open Library",
        "title": title,
        "authors": authors,
        "year": year,
        "doi": doi,
        "journal": journal,
        "url": url,
        "search_url": f"https://openlibrary.org/search?q={quote(search_query)}",
    }

    return score_match(source, candidate)
