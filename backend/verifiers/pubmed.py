"""PubMed (NCBI E-utilities) verifier - US National Library of Medicine.

PubMed covers 36M+ biomedical citations. While it overlaps with Europe PMC,
PubMed has unique US-focused content and earlier indexing of some records.
No API key required, but an api_key (NCBI) improves rate limits.
"""

import aiohttp
from urllib.parse import quote

from models.source import ParsedSource
from models.verification_result import MatchResult
from scrapers.rate_limiter import rate_limiter
from services.match_scorer import score_match
from verifiers._http import check_parked_url, check_rate_limit, get_session

ESEARCH_URL = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi"
ESUMMARY_URL = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi"
_HOST = "eutils.ncbi.nlm.nih.gov"


async def search(source: ParsedSource, api_key: str | None = None) -> MatchResult | None:
    """Search PubMed by DOI or title.

    Errors propagate so the orchestrator can surface them as
    ``db_status: "error"`` instead of silently returning ``not_found``.
    """
    session = get_session()
    # Priority 1: DOI lookup
    if source.doi:
        result = await _search_query(session, f'{source.doi}[doi]', source, api_key)
        if result and result.score >= 0.5:
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
    }

    return score_match(source, candidate)
