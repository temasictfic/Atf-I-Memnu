"""Crossref API verifier - DOI lookup and bibliographic search."""

import re
from typing import Any
from urllib.parse import quote, quote_plus

import aiohttp

from models.source import ParsedSource
from models.verification_result import MatchResult
from services.match_scorer import score_match
from verifiers._http import get_session

CROSSREF_API = "https://api.crossref.org/works"
HEADERS = {
    "User-Agent": "AtfiMemnu/1.0 (Citation Search and Verification; mailto:atfimemnu@example.com)"
}


async def search_by_doi(source: ParsedSource) -> MatchResult | None:
    """Direct DOI lookup via Crossref."""
    if not source.doi:
        return None

    session = get_session()
    url = f"{CROSSREF_API}/{quote(source.doi, safe='')}"
    async with session.get(url, headers=HEADERS) as resp:
        if resp.status != 200:
            return None
        data = await resp.json()
        item = data.get("message", {})
        return _item_to_match(item, source)


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
    bibliographic_query = (source.raw_text or "").strip() or query
    if not bibliographic_query:
        return None

    params: dict[str, str] = {
        "query.bibliographic": bibliographic_query,
        "rows": "5",
    }
    if query:
        params["query.title"] = query

    # Add author disambiguation only when parsing is strong and citation
    # doesn't look editor-led (Ed./Eds.), where Crossref author filtering
    # can suppress the correct book-level record.
    author_query = _build_author_query(source.authors)
    if (
        author_query
        and source.parse_confidence >= 0.7
        and not _looks_like_editor_reference(source.raw_text)
    ):
        params["query.author"] = author_query

    # Add container-title to separate editions published by different houses
    # under slightly different encyclopedia/journal titles.
    if source.source and _is_specific_container_title(source.source):
        params["query.container-title"] = source.source

    # Year-range filter (±1 year) excludes papers from other editions whose
    # publication year differs from the cited one.  A tolerance of one year
    # absorbs common print-vs-online date discrepancies.
    if source.year:
        params["filter"] = (
            f"from-pub-date:{source.year - 1},until-pub-date:{source.year + 1}"
        )

    session = get_session()
    variants: list[dict[str, str]] = [params]
    if "query.container-title" in params:
        variants.append({k: v for k, v in params.items() if k != "query.container-title"})
    if "query.author" in params:
        variants.append({k: v for k, v in params.items() if k != "query.author"})
    if "filter" in params:
        variants.append({k: v for k, v in params.items() if k != "filter"})
    if "query.author" in params and "filter" in params:
        variants.append({
            k: v for k, v in params.items()
            if k not in {"query.author", "filter"}
        })
    if "query.container-title" in params and "filter" in params:
        variants.append({
            k: v for k, v in params.items()
            if k not in {"query.container-title", "filter"}
        })
    if "query.container-title" in params and "query.author" in params:
        variants.append({
            k: v for k, v in params.items()
            if k not in {"query.container-title", "query.author"}
        })
    if (
        "query.container-title" in params
        and "query.author" in params
        and "filter" in params
    ):
        variants.append({
            k: v for k, v in params.items()
            if k not in {"query.container-title", "query.author", "filter"}
        })

    best: MatchResult | None = None
    for variant in variants:
        result = await _fetch_best_match(session, variant, source)
        if result and (best is None or result.score > best.score):
            best = result

    return best


async def _fetch_best_match(
    session: aiohttp.ClientSession,
    params: dict[str, str],
    source: ParsedSource,
) -> MatchResult | None:
    """Execute one Crossref API request and return the highest-scoring match."""
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


def _build_author_query(authors: list[str]) -> str:
    """Build a Crossref-friendly author query from parsed authors."""
    if not authors:
        return ""

    names: list[str] = []
    seen: set[str] = set()
    for author in authors:
        family = _extract_family_name(author)
        if not family:
            continue
        key = family.lower()
        if key in seen:
            continue
        seen.add(key)
        names.append(family)
        if len(names) >= 2:
            break

    return " ".join(names)


def _extract_family_name(author: str) -> str:
    """Extract a likely family name from an author token."""
    raw = (author or "").strip().strip(",.")
    if not raw:
        return ""
    if raw.lower() in {"ed", "eds", "editor", "editors"}:
        return ""

    if "," in raw:
        candidate = raw.split(",", 1)[0].strip()
    else:
        # Initials-first style: "A. Bajaj" -> "Bajaj"
        initials_first = re.match(r"^(?:[A-Z]\.?(?:\s+|$))+([A-Z][A-Za-z'\-]+)$", raw)
        if initials_first:
            candidate = initials_first.group(1).strip()
        else:
            parts = [p for p in re.split(r"\s+", raw) if p]
            candidate = parts[-1] if parts else ""

    candidate = re.sub(r"[^A-Za-z\-']", "", candidate).strip("-'")
    if len(candidate) < 2:
        return ""
    return candidate


def _looks_like_editor_reference(raw_text: str) -> bool:
    """Detect book/editor citations where author filtering is unreliable."""
    text = (raw_text or "").lower()
    return bool(re.search(r"\b(?:ed\.|eds\.|editor|editors)\b", text))


def _is_specific_container_title(journal: str) -> bool:
    """Return False for short/generic container titles that over-filter results."""
    value = (journal or "").strip()
    if not value:
        return False

    normalized = re.sub(r"[^a-z]", "", value.lower())
    if len(normalized) < 6:
        return False

    generic = {
        "proc",
        "proceedings",
        "conference",
        "conf",
        "journal",
        "book",
    }
    if normalized in generic:
        return False

    return True
