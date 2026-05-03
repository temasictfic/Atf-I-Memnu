"""Web of Science Starter API verifier.

Clarivate's WoS Starter API uses an ``X-ApiKey`` header for authentication.
Without an API key (read from ``api_keys["wos"]`` in settings) the verifier
returns ``None`` silently — same opt-in pattern as BASE — so a user who
toggles WoS on without entering a key still sees a clean "no_match" rather
than a spammy red error dot.

Endpoint works with both free Starter tokens and Expanded API keys issued
under an institutional Web of Science Core Collection subscription. Apply
at https://developer.clarivate.com/.
"""

import logging
from typing import Any
from urllib.parse import quote

import aiohttp

from models.source import ParsedSource
from models.verification_result import MatchResult
from scrapers.rate_limiter import rate_limiter
from services.match_scorer import score_match
from services.scoring_constants import DOI_MATCH_MIN_SCORE
from verifiers._http import (
    build_headers,
    check_parked_url,
    check_rate_limit,
    get_session,
)

WOS_API = "https://api.clarivate.com/apis/wos-starter/v1/documents"
_HOST = "api.clarivate.com"

_log = logging.getLogger(__name__)
# Single-shot warn so the user sees one info line per process when their key
# is rejected, not one per source in a 200-citation batch.
_warned_unauthorized = False


async def search(source: ParsedSource, api_key: str | None = None) -> MatchResult | None:
    """Search WoS Core Collection by DOI then by title.

    DOI lookup is preferred — WoS query syntax ``DO=<doi>`` returns the
    canonical record directly, no scoring noise. Falls back to ``TI=`` title
    search with a ±1-year filter when no DOI is parsed.
    """
    if not api_key:
        return None

    session = get_session()
    headers = {**build_headers(), "X-ApiKey": api_key}

    if source.doi:
        params = {"q": f"DO={source.doi}", "db": "WOS", "limit": "5"}
        result = await _query(session, params, source, headers)
        if result and result.score >= DOI_MATCH_MIN_SCORE:
            return result

    title = (source.title or "").strip()
    if not title:
        return None

    # WoS query: TI for the title field. Strip embedded double quotes —
    # the ``q`` parameter is a single-line query string and a stray quote
    # would unbalance the phrase wrapper.
    safe_title = title.replace('"', "")
    base_q = f'TI="{safe_title}"'

    # Year-restricted pass first; fall back to a year-less query when the
    # filter eliminated everything (mirrors fetch_with_year_fallback, but
    # implemented inline because the year filter is embedded inside ``q``
    # rather than being a separate dropable param).
    if source.year:
        params_with_year = {
            "q": f"{base_q} AND PY={source.year - 1}-{source.year + 1}",
            "db": "WOS",
            "limit": "5",
        }
        result = await _query(session, params_with_year, source, headers)
        if result is not None:
            return result

    return await _query(
        session,
        {"q": base_q, "db": "WOS", "limit": "5"},
        source,
        headers,
    )


async def _query(
    session: aiohttp.ClientSession,
    params: dict[str, str],
    source: ParsedSource,
    headers: dict[str, str],
) -> MatchResult | None:
    """Execute one WoS request and return the highest-scoring hit."""
    global _warned_unauthorized
    check_parked_url(WOS_API)
    await rate_limiter.acquire(_HOST)
    async with session.get(WOS_API, params=params, headers=headers) as resp:
        check_rate_limit(resp)
        if resp.status in (401, 403):
            if not _warned_unauthorized:
                _log.info(
                    "Web of Science returned HTTP %s — invalid or expired API key. "
                    "Update the key in Settings -> API Keys.",
                    resp.status,
                )
                _warned_unauthorized = True
            return None
        if resp.status != 200:
            return None
        try:
            data = await resp.json(content_type=None)
        except (aiohttp.ContentTypeError, ValueError):
            return None

        hits = data.get("hits") or []
        if not isinstance(hits, list):
            return None

        best: MatchResult | None = None
        for hit in hits[:5]:
            match = _hit_to_match(hit, source)
            if match and (best is None or match.score > best.score):
                best = match
        return best


def _hit_to_match(hit: dict[str, Any], source: ParsedSource) -> MatchResult | None:
    """Convert a WoS Starter API hit to a MatchResult."""
    title = hit.get("title") or ""
    if not title:
        return None

    names = hit.get("names") or {}
    authors_raw = names.get("authors") if isinstance(names, dict) else []
    authors: list[str] = []
    if isinstance(authors_raw, list):
        for a in authors_raw:
            if isinstance(a, dict):
                name = a.get("displayName") or a.get("wosStandard") or ""
                if name:
                    authors.append(name)

    src_obj = hit.get("source") or {}
    if not isinstance(src_obj, dict):
        src_obj = {}
    journal = src_obj.get("sourceTitle") or ""

    year_raw = src_obj.get("publishYear")
    year: int | None = None
    if year_raw not in (None, ""):
        try:
            year = int(year_raw)
        except (ValueError, TypeError):
            year = None

    volume_raw = src_obj.get("volume")
    issue_raw = src_obj.get("issue")
    volume = str(volume_raw).strip() if volume_raw not in (None, "") else None
    issue = str(issue_raw).strip() if issue_raw not in (None, "") else None

    # WoS Starter encodes pages as {"range": "1-10", "begin": "1", "end": "10"}
    # but older / partial records may carry just a string. Accept both.
    pages: str | None = None
    pages_obj = src_obj.get("pages")
    if isinstance(pages_obj, dict):
        pages = pages_obj.get("range") or None
        if not pages:
            begin, end = pages_obj.get("begin"), pages_obj.get("end")
            if begin and end:
                pages = f"{begin}-{end}"
            elif begin:
                pages = str(begin)
    elif isinstance(pages_obj, str) and pages_obj:
        pages = pages_obj

    identifiers = hit.get("identifiers") or {}
    if not isinstance(identifiers, dict):
        identifiers = {}
    doi = identifiers.get("doi") or ""
    issn_raw = identifiers.get("issn") or identifiers.get("eissn") or ""
    issn_list = [issn_raw] if issn_raw else []

    links = hit.get("links") or {}
    record_url = links.get("record") if isinstance(links, dict) else ""
    url = f"https://doi.org/{doi}" if doi else (record_url or "")

    types = hit.get("types") or []
    document_type = ""
    if isinstance(types, list) and types:
        document_type = str(types[0]) if types[0] else ""

    search_query = source.title or (source.raw_text[:100] if source.raw_text else "")
    candidate = {
        "database": "Web of Science",
        "title": title,
        "authors": authors,
        "year": year,
        "doi": doi,
        "journal": journal,
        "url": url,
        "search_url": f"https://www.webofscience.com/wos/woscc/basic-search?type=general&value={quote(search_query)}",
        "volume": volume,
        "issue": issue,
        "pages": pages,
        "document_type": document_type,
        "issn": issn_list,
    }
    return score_match(source, candidate)
