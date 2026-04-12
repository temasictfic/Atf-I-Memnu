"""PLOS (Public Library of Science) API verifier.

PLOS provides free access to all published PLOS journal articles via a
Solr-based search API. No API key required.
"""

import aiohttp
from urllib.parse import quote

from models.source import ParsedSource
from models.verification_result import MatchResult
from services.match_scorer import score_match
from services.search_settings import get_client_timeout

PLOS_API = "https://api.plos.org/search"


async def search(source: ParsedSource) -> MatchResult | None:
    """Search PLOS by DOI or title."""
    try:
        async with aiohttp.ClientSession(timeout=get_client_timeout()) as session:
            # Priority 1: DOI lookup
            if source.doi:
                result = await _search_query(session, f'id:"{source.doi}"', source)
                if result and result.score >= 0.5:
                    return result

            # Priority 2: Title search
            query = source.title
            if not query:
                return None

            return await _search_query(session, f'title:"{query}"', source)
    except Exception:
        return None


async def _search_query(
    session: aiohttp.ClientSession,
    query: str,
    source: ParsedSource,
) -> MatchResult | None:
    """Execute a PLOS API search and return the best match."""
    params = {
        "q": query,
        "fl": "id,title_display,author_display,publication_date,journal,abstract",
        "wt": "json",
        "rows": "5",
    }

    try:
        async with session.get(PLOS_API, params=params) as resp:
            if resp.status != 200:
                return None
            data = await resp.json()
            docs = data.get("response", {}).get("docs", [])

            best: MatchResult | None = None
            for item in docs[:5]:
                match = _item_to_match(item, source)
                if match and (best is None or match.score > best.score):
                    best = match
            return best
    except Exception:
        return None


def _item_to_match(item: dict, source: ParsedSource) -> MatchResult | None:
    title = item.get("title_display", "")

    # Authors come as a list of strings
    authors = item.get("author_display", [])
    if not isinstance(authors, list):
        authors = []

    year = None
    pub_date = item.get("publication_date", "")
    if pub_date:
        try:
            year = int(pub_date[:4])
        except (ValueError, TypeError):
            pass

    doi = item.get("id", "")
    journal = item.get("journal", "")
    url = f"https://doi.org/{doi}" if doi else ""

    search_query = source.title or source.raw_text[:100]
    candidate = {
        "database": "PLOS",
        "title": title,
        "authors": authors,
        "year": year,
        "doi": doi,
        "journal": journal,
        "url": url,
        "search_url": f"https://journals.plos.org/plosone/search?q={quote(search_query)}",
    }

    return score_match(source, candidate)
