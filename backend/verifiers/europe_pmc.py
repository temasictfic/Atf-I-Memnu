"""Europe PMC API verifier - free biomedical and life sciences literature."""

import aiohttp
from urllib.parse import quote

from models.source import ParsedSource
from models.verification_result import MatchResult
from services.match_scorer import score_match
from services.search_settings import get_client_timeout

EUROPE_PMC_API = "https://www.ebi.ac.uk/europepmc/webservices/rest/search"


async def search(source: ParsedSource) -> MatchResult | None:
    """Search Europe PMC by title (or DOI if available)."""
    try:
        async with aiohttp.ClientSession(timeout=get_client_timeout()) as session:
            # Priority 1: DOI lookup
            if source.doi:
                result = await _search_query(session, f'DOI:"{source.doi}"', source)
                if result and result.score >= 0.5:
                    return result

            # Priority 2: Title search
            query = source.title
            if not query:
                return None

            return await _search_query(session, f'TITLE:"{query}"', source)
    except Exception:
        return None


async def _search_query(
    session: aiohttp.ClientSession, query: str, source: ParsedSource
) -> MatchResult | None:
    """Execute a Europe PMC search and return the best match."""
    params = {
        "query": query,
        "format": "json",
        "pageSize": "5",
    }
    try:
        async with session.get(EUROPE_PMC_API, params=params) as resp:
            if resp.status != 200:
                return None
            data = await resp.json()
            results = data.get("resultList", {}).get("result", [])

            best: MatchResult | None = None
            for item in results[:5]:
                match = _item_to_match(item, source)
                if match and (best is None or match.score > best.score):
                    best = match
            return best
    except Exception:
        return None


def _item_to_match(item: dict, source: ParsedSource) -> MatchResult | None:
    title = item.get("title", "")

    # Authors come as a single string: "Author A, Author B, Author C"
    author_string = item.get("authorString", "")
    authors = [a.strip() for a in author_string.split(",") if a.strip()] if author_string else []

    year = None
    pub_year = item.get("pubYear")
    if pub_year:
        try:
            year = int(pub_year)
        except (ValueError, TypeError):
            pass

    doi = item.get("doi", "")
    journal = item.get("journalTitle", "")

    # Build article URL
    source_type = item.get("source", "")
    ext_id = item.get("id", "")
    if source_type and ext_id:
        url = f"https://europepmc.org/article/{source_type}/{ext_id}"
    else:
        url = ""

    search_query = source.title or source.raw_text[:100]
    candidate = {
        "database": "Europe PMC",
        "title": title,
        "authors": authors,
        "year": year,
        "doi": doi,
        "journal": journal,
        "url": url,
        "search_url": f"https://europepmc.org/search?query={quote(search_query)}",
    }

    return score_match(source, candidate)
