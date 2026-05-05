"""PubMed (NCBI E-utilities) verifier - US National Library of Medicine.

PubMed covers 36M+ biomedical citations. While it overlaps with Europe PMC,
PubMed has unique US-focused content and earlier indexing of some records.
No API key required, but an api_key (NCBI) improves rate limits.
"""

import time
from urllib.parse import quote

import aiohttp

from models.source import ParsedSource
from models.verification_result import MatchResult
from scrapers.rate_limiter import rate_limiter
from services.match_scorer import score_match
from services.scoring_constants import DOI_MATCH_MIN_SCORE
from verifiers._http import (
    UnauthorizedError,
    check_parked_url,
    check_rate_limit,
    get_session,
    raise_for_unexpected_status,
)

ESEARCH_URL = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi"
ESUMMARY_URL = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi"
_HOST = "eutils.ncbi.nlm.nih.gov"

# Cooldown after NCBI rejects the supplied key — avoids hammering eutils
# with denied requests for every reference in a batch.
_UNAUTHORIZED_COOLDOWN_SEC = 3600.0
_unauthorized_until: float = 0.0
_UNAUTHORIZED_HINT = (
    "NCBI rejected the API key. Update it in Settings → API Keys "
    "(generate one at https://www.ncbi.nlm.nih.gov/account/settings/)."
)


async def search(source: ParsedSource, api_key: str | None = None) -> MatchResult | None:
    """Search PubMed by DOI or title.

    Errors propagate so the orchestrator can surface them as
    ``db_status: "error"`` instead of silently returning ``not_found``.
    """
    session = get_session()
    # Priority 1: DOI lookup
    if source.doi:
        result = await _search_query(session, f'{source.doi}[doi]', source, api_key)
        if result and result.score >= DOI_MATCH_MIN_SCORE:
            return result

    # Priority 2: Title search
    query = source.title
    if not query:
        return None

    return await _search_query(session, f'{query}[Title]', source, api_key)


async def _search_query(
    session: aiohttp.ClientSession,
    query: str,
    source: ParsedSource,
    api_key: str | None = None,
) -> MatchResult | None:
    """Execute an ESearch + ESummary and return the best match."""
    global _unauthorized_until
    has_key = bool(api_key)
    now = time.monotonic()
    if has_key and now < _unauthorized_until:
        raise UnauthorizedError(_HOST, detail=_UNAUTHORIZED_HINT)

    params: dict[str, str] = {
        "db": "pubmed",
        "term": query,
        "retmode": "json",
        "retmax": "5",
    }
    if api_key:
        params["api_key"] = api_key

    # Step 1: ESearch to get PMIDs
    check_parked_url(ESEARCH_URL)
    await rate_limiter.acquire(_HOST)
    async with session.get(ESEARCH_URL, params=params) as resp:
        check_rate_limit(resp)
        if has_key and resp.status in (401, 403):
            _unauthorized_until = now + _UNAUTHORIZED_COOLDOWN_SEC
            raise UnauthorizedError(_HOST, detail=_UNAUTHORIZED_HINT, status=resp.status)
        raise_for_unexpected_status(_HOST, resp)
        if resp.status != 200:
            return None
        data = await resp.json()
        id_list = data.get("esearchresult", {}).get("idlist", [])
        if not id_list:
            return None

    # Step 2: ESummary to get metadata
    summary_params: dict[str, str] = {
        "db": "pubmed",
        "id": ",".join(id_list),
        "retmode": "json",
    }
    if api_key:
        summary_params["api_key"] = api_key

    check_parked_url(ESUMMARY_URL)
    await rate_limiter.acquire(_HOST)
    async with session.get(ESUMMARY_URL, params=summary_params) as resp:
        check_rate_limit(resp)
        if has_key and resp.status in (401, 403):
            _unauthorized_until = now + _UNAUTHORIZED_COOLDOWN_SEC
            raise UnauthorizedError(_HOST, detail=_UNAUTHORIZED_HINT, status=resp.status)
        raise_for_unexpected_status(_HOST, resp)
        if resp.status != 200:
            return None
        data = await resp.json()
        results = data.get("result", {})

        best: MatchResult | None = None
        for pmid in id_list:
            item = results.get(pmid)
            if not item or isinstance(item, str):
                continue
            match = _item_to_match(item, pmid, source)
            if match and (best is None or match.score > best.score):
                best = match
        return best


def _item_to_match(item: dict, pmid: str, source: ParsedSource) -> MatchResult | None:
    title = item.get("title", "")

    # Authors come as list of dicts with "name" key
    author_list = item.get("authors", [])
    authors = [a.get("name", "") for a in author_list if isinstance(a, dict) and a.get("name")]

    year = None
    pub_date = item.get("pubdate", "")
    if pub_date:
        try:
            year = int(pub_date[:4])
        except (ValueError, TypeError):
            pass

    doi = ""
    article_ids = item.get("articleids", [])
    for aid in article_ids:
        if isinstance(aid, dict) and aid.get("idtype") == "doi":
            doi = aid.get("value", "")
            break

    journal = item.get("fulljournalname", "") or item.get("source", "")
    url = f"https://pubmed.ncbi.nlm.nih.gov/{pmid}/"

    issn_list = [
        v for v in (item.get("issn", ""), item.get("essn", ""))
        if isinstance(v, str) and v
    ]
    pubtypes = item.get("pubtype") or []
    document_type = ""
    if isinstance(pubtypes, list) and pubtypes:
        document_type = str(pubtypes[0]) if pubtypes[0] else ""

    search_query = source.title or source.raw_text[:100]
    candidate = {
        "database": "PubMed",
        "title": title,
        "authors": authors,
        "year": year,
        "doi": doi,
        "journal": journal,
        "url": url,
        "search_url": f"https://pubmed.ncbi.nlm.nih.gov/?term={quote(search_query)}",
        "volume": item.get("volume") or None,
        "issue": item.get("issue") or None,
        "pages": item.get("pages") or None,
        "document_type": document_type,
        "issn": issn_list,
    }

    return score_match(source, candidate)
