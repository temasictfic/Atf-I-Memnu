"""TRDizin verifier - Turkish national academic database (JSON API)."""

from typing import Any
from urllib.parse import quote

import aiohttp

from models.source import ParsedSource
from models.verification_result import MatchResult
from services.match_scorer import score_match
from services.search_settings import get_client_timeout

TRDIZIN_API = "https://search.trdizin.gov.tr/api/defaultSearch/publication/"


async def search(source: ParsedSource) -> MatchResult | None:
    """Search TRDizin by title via their JSON API."""
    query = source.title
    if not query:
        return None

    params = {
        "q": query,
        "order": "relevance-DESC",
        "page": "1",
        "limit": "5",
    }

    search_url = f"https://search.trdizin.gov.tr/tr/yayin/ara?q={quote(query, safe=',')}&order=relevance-DESC&page=1&limit=20"

    try:
        async with aiohttp.ClientSession(timeout=get_client_timeout()) as session:
            async with session.get(TRDIZIN_API, params=params) as resp:
                if resp.status != 200:
                    return None
                data = await resp.json()

                hits = data.get("hits", {}).get("hits", [])
                if not hits:
                    return None

                best: MatchResult | None = None
                for hit in hits[:5]:
                    match = _hit_to_match(hit, source, search_url)
                    if match and (best is None or match.score > best.score):
                        best = match
                return best
    except Exception:
        return None


def _hit_to_match(hit: dict[str, Any], source: ParsedSource, search_url: str) -> MatchResult | None:
    """Convert a TRDizin API hit to a MatchResult."""
    src = hit.get("_source", {})
    if not src:
        return None

    # Title: from abstracts array (prefer Turkish or first available)
    title = ""
    abstracts = src.get("abstracts", [])
    for abstract in abstracts:
        t = abstract.get("title", "")
        if t:
            title = t
            break

    if not title:
        return None

    # Authors
    authors = []
    for author in src.get("authors", []):
        name = author.get("name", "")
        if name:
            authors.append(name)

    # Year
    year = src.get("publicationYear")

    # DOI
    doi = src.get("doi", "") or ""

    # Journal
    journal = ""
    journal_info = src.get("journal", {})
    if journal_info:
        journal = journal_info.get("name", "")

    # URL: construct from the record ID
    record_id = hit.get("_id", "")
    url = f"https://search.trdizin.gov.tr/tr/yayin/detay/{record_id}" if record_id else ""
    if doi:
        url = f"https://doi.org/{doi}"

    candidate = {
        "database": "TRDizin",
        "title": title,
        "authors": authors,
        "year": year,
        "doi": doi,
        "journal": journal,
        "url": url,
        "search_url": search_url,
    }

    return score_match(source, candidate)
