"""BASE (Bielefeld Academic Search Engine) verifier.

BASE indexes ~400M records from open-access repositories worldwide and is
particularly strong on non-English / repository-only sources that Crossref,
PubMed, and the other Tier-1 verifiers miss.

Access requires IP allowlist registration via
https://www.base-search.net/about/en/contact.php — applicants must select
**"Access BASE's HTTP API"** (NOT OAI-PMH; this verifier uses the search
interface). Without an allowlisted IP the API returns 401/403, which this
verifier handles silently so the remaining 9 verifiers carry on.

The optional ``api_key`` (read from ``api_keys["base"]`` in settings) is
forwarded as a ``user`` parameter — BASE uses it as a contact identifier
for allowlisted callers.
"""

import logging
from typing import Any
from urllib.parse import quote

import aiohttp

from models.source import ParsedSource
from models.verification_result import MatchResult
from scrapers.rate_limiter import rate_limiter
from services.match_scorer import score_match
from verifiers._http import (
    check_parked_url,
    check_rate_limit,
    fetch_with_year_fallback,
    get_session,
)

BASE_API = "https://api.base-search.net/cgi-bin/BaseHttpSearchInterface.fcgi"
_HOST = "api.base-search.net"

_log = logging.getLogger(__name__)
# Single-shot warn so the user sees one info line per process, not one per source.
_warned_unavailable = False


def _coerce_str(value: Any) -> str:
    """Return the first string in a list, or the value itself when string."""
    if isinstance(value, list):
        return str(value[0]) if value else ""
    return str(value) if value else ""


def _coerce_list(value: Any) -> list[str]:
    if isinstance(value, list):
        return [str(x) for x in value if x]
    if isinstance(value, str) and value:
        return [value]
    return []


async def search(source: ParsedSource, api_key: str | None = None) -> MatchResult | None:
    """Search BASE by title (and first-author surname when available).

    Mirrors the OpenAlex / Semantic Scholar pattern: title-quoted Solr query,
    ±1-year filter, single retry without the year filter on empty result.
    """
    title = (source.title or "").strip()
    if not title:
        return None

    # Solr phrase query on dctitle. Add a dccreator filter when at least one
    # parsed author is available — keeps the result set targeted on common
    # titles like "Introduction".
    query_parts = [f'dctitle:"{title}"']
    if source.authors:
        first = (source.authors[0] or "").split(",")[0].strip()
        if first and len(first) > 1:
            query_parts.append(f'dccreator:"{first}"')
    query = " AND ".join(query_parts)

    params: dict[str, str] = {
        "func": "PerformSearch",
        "format": "json",
        "hits": "5",
        "query": query,
    }
    if source.year:
        params["filter"] = f"dcyear:[{source.year - 1} TO {source.year + 1}]"
    if api_key:
        params["user"] = api_key

    session = get_session()
    return await fetch_with_year_fallback(
        lambda p: _fetch_best_match(session, p, source),
        params,
        {"filter"},
    )


async def _fetch_best_match(
    session: aiohttp.ClientSession,
    params: dict[str, str],
    source: ParsedSource,
) -> MatchResult | None:
    """Execute one BASE request and return the highest-scoring hit."""
    global _warned_unavailable
    check_parked_url(BASE_API)
    await rate_limiter.acquire(_HOST)
    async with session.get(BASE_API, params=params) as resp:
        check_rate_limit(resp)
        if resp.status in (401, 403):
            if not _warned_unavailable:
                _log.info(
                    "BASE returned HTTP %s — IP not allowlisted. Register at "
                    "https://www.base-search.net/about/en/contact.php and "
                    "select 'Access BASE's HTTP API' to enable.",
                    resp.status,
                )
                _warned_unavailable = True
            return None
        if resp.status != 200:
            return None
        try:
            data = await resp.json(content_type=None)
        except aiohttp.ContentTypeError:
            return None

        docs = (data.get("response") or {}).get("docs") or []
        best: MatchResult | None = None
        for doc in docs[:5]:
            match = _doc_to_match(doc, source)
            if match and (best is None or match.score > best.score):
                best = match
        return best


def _doc_to_match(doc: dict[str, Any], source: ParsedSource) -> MatchResult | None:
    title = _coerce_str(doc.get("dctitle"))
    if not title:
        return None

    authors = _coerce_list(doc.get("dccreator"))

    year_raw = _coerce_str(doc.get("dcyear"))
    year: int | None = None
    if year_raw:
        try:
            year = int(year_raw[:4])
        except ValueError:
            year = None

    doi = _coerce_str(doc.get("dcdoi"))
    journal = _coerce_str(doc.get("dcsource"))

    # dclink can be a string (sometimes ;-separated) or a list of URLs.
    link_raw = doc.get("dclink") or doc.get("dcidentifier") or ""
    if isinstance(link_raw, list) and link_raw:
        url = str(link_raw[0])
    elif isinstance(link_raw, str):
        url = link_raw.split(";")[0].strip()
    else:
        url = ""
    if not url and doi:
        url = f"https://doi.org/{doi}"

    publisher = _coerce_str(doc.get("dcpublisher"))
    document_type = _coerce_str(doc.get("dctype"))
    language = _coerce_str(doc.get("dclanguage"))
    issn_list = _coerce_list(doc.get("dcissn"))
    isbn_list = _coerce_list(doc.get("dcisbn"))

    search_query = source.title or (source.raw_text[:100] if source.raw_text else "")
    candidate = {
        "database": "BASE",
        "title": title,
        "authors": authors,
        "year": year,
        "doi": doi,
        "journal": journal,
        "url": url,
        "search_url": f"https://www.base-search.net/Search/Results?lookfor={quote(search_query)}",
        "publisher": publisher,
        "document_type": document_type,
        "language": language,
        "issn": issn_list,
        "isbn": isbn_list,
    }
    return score_match(source, candidate)
