"""Crossref API verifier - DOI lookup and bibliographic search."""

from typing import Any
from urllib.parse import quote, quote_plus

import aiohttp

from models.source import ParsedSource
from models.verification_result import MatchResult
from services.match_scorer import score_match
from services.search_settings import get_client_timeout

CROSSREF_API = "https://api.crossref.org/works"
HEADERS = {
    "User-Agent": "AtfiMemnu/1.0 (Citation Search and Verification; mailto:atfimemnu@example.com)"
}


async def search_by_doi(source: ParsedSource) -> MatchResult | None:
    """Direct DOI lookup via Crossref."""
    if not source.doi:
        return None

    try:
        async with aiohttp.ClientSession(timeout=get_client_timeout()) as session:
            url = f"{CROSSREF_API}/{quote(source.doi, safe='')}"
            async with session.get(url, headers=HEADERS) as resp:
                if resp.status != 200:
                    return None
                data = await resp.json()
                item = data.get("message", {})
                return _item_to_match(item, source)
    except Exception:
        return None


async def search(source: ParsedSource) -> MatchResult | None:
    """Search Crossref — tries DOI lookup first, then enriched bibliographic search.

    The bare title alone (e.g. "Natural disasters") can match the same chapter
    across multiple editions published by different houses.  To disambiguate we
    pass the full raw reference text as query.bibliographic (so Crossref's own
    relevance ranker sees authors, year, journal, etc.) and layer on specific
    field params (query.author, query.container-title) plus a ±1-year date
    filter so that a newer re-edition of the same work cannot shadow the
    originally cited one.
    """
    # 1. DOI lookup takes priority — unambiguous when a DOI is present.
    if source.doi:
        doi_result = await search_by_doi(source)
        if doi_result and doi_result.score >= 0.5:
            return doi_result

    # 2. Build a title-based query with enriched filters.
    #    Title-only queries produce better results; author/journal/year filters
    #    help Crossref disambiguate without polluting the primary search.
    query = source.title or ""
    if not query:
        return None

    params: dict[str, str] = {
        "query.bibliographic": query,
        "rows": "5",
    }

    # Add author disambiguation: last names of the first two authors.
    if source.authors:
        last_names = [a.split(",")[0].strip() for a in source.authors[:2]]
        author_query = " ".join(n for n in last_names if n)
        if author_query:
            params["query.author"] = author_query

    # Add container-title to separate editions published by different houses
    # under slightly different encyclopedia/journal titles.
    if source.journal:
        params["query.container-title"] = source.journal

    # Year-range filter (±1 year) excludes papers from other editions whose
    # publication year differs from the cited one.  A tolerance of one year
    # absorbs common print-vs-online date discrepancies.
    if source.year:
        params["filter"] = (
            f"from-pub-date:{source.year - 1},until-pub-date:{source.year + 1}"
        )

    try:
        async with aiohttp.ClientSession(timeout=get_client_timeout()) as session:
            best = await _fetch_best_match(session, params, source)

            # If the year filter produced no usable results (e.g. the parsed
            # year was wrong), retry without it so we don't silently miss the
            # correct paper.
            if best is None and "filter" in params:
                params_no_filter = {k: v for k, v in params.items() if k != "filter"}
                best = await _fetch_best_match(session, params_no_filter, source)

            return best
    except Exception:
        return None


async def _fetch_best_match(
    session: aiohttp.ClientSession,
    params: dict[str, str],
    source: ParsedSource,
) -> MatchResult | None:
    """Execute one Crossref API request and return the highest-scoring match."""
    try:
        async with session.get(CROSSREF_API, params=params, headers=HEADERS) as resp:
            if resp.status != 200:
                return None
            data = await resp.json()
            items = data.get("message", {}).get("items", [])

            best: MatchResult | None = None
            for item in items[:5]:
                match = _item_to_match(item, source)
                if match and (best is None or match.score > best.score):
                    best = match
            return best
    except Exception:
        return None


def _item_to_match(item: dict[str, Any], source: ParsedSource) -> MatchResult | None:
    """Convert a Crossref work item to a MatchResult."""
    title_parts = item.get("title", [])
    title = title_parts[0] if title_parts else ""

    authors = []
    for author in item.get("author", []):
        name = f"{author.get('family', '')}, {author.get('given', '')}".strip(", ")
        if name:
            authors.append(name)

    year = None
    date_parts = item.get("published-print", {}).get("date-parts", [[]])
    if not date_parts or not date_parts[0]:
        date_parts = item.get("published-online", {}).get("date-parts", [[]])
    if date_parts and date_parts[0]:
        year = date_parts[0][0]

    doi = item.get("DOI", "")

    journal_parts = item.get("container-title", [])
    journal = journal_parts[0] if journal_parts else ""

    candidate = {
        "database": "Crossref",
        "title": title,
        "authors": authors,
        "year": year,
        "doi": doi,
        "journal": journal,
        "url": f"https://doi.org/{doi}" if doi else "",
        "search_url": f"https://search.crossref.org/search/works?q={quote_plus(source.title or source.raw_text[:100])}&from_ui=yes",
    }

    return score_match(source, candidate)
