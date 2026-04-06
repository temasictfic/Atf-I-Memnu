"""arXiv API verifier - search via Atom feed API."""

import re
import xml.etree.ElementTree as ET
from urllib.parse import quote

import aiohttp

from models.source import ParsedSource
from models.verification_result import MatchResult
from scrapers.rate_limiter import rate_limiter
from services.match_scorer import score_match
from services.search_settings import get_client_timeout
from utils.doi_extractor import extract_arxiv_id

ARXIV_API = "http://export.arxiv.org/api/query"
NS = {"atom": "http://www.w3.org/2005/Atom"}


def _build_arxiv_query(source: ParsedSource, with_author: bool = True) -> str:
    """Build an arXiv structured query.

    With author:    ti:"{sanitized title}" AND au:{lastname}
    Without author: ti:"{sanitized title}"

    The date filter is intentionally omitted: arXiv preprints are often
    submitted months or years before the citing paper's publication year,
    so a year window would incorrectly exclude valid matches.

    Colons are stripped from the title before quoting because the arXiv
    Lucene parser treats ":" as a field separator even inside a quoted
    phrase, turning e.g. ti:"16x16 words: Transformers..." into a broken
    query that returns zero results.
    """
    title = source.title or source.raw_text[:200]
    # Remove characters that are Lucene field-separator or escape tokens.
    # The colon is the critical one (field:value syntax breaks phrase search).
    sanitized = re.sub(r'[:\\"\\+\\-!\\(\\)\\{\\}\\[\\]\\^~\\*\\?/]', " ", title)
    sanitized = " ".join(sanitized.split())  # collapse whitespace

    parts = [f'ti:"{sanitized}"']

    if with_author and source.authors:
        last_name = source.authors[0].split(",")[0].strip()
        if last_name:
            parts.append(f"au:{last_name}")

    return " AND ".join(parts)


def _strip_arxiv_version(url: str) -> str:
    """Remove the version suffix (v1, v2, …) from an arXiv abstract URL.

    https://arxiv.org/abs/2010.11929v2  →  https://arxiv.org/abs/2010.11929
    http://arxiv.org/abs/2010.11929v12  →  http://arxiv.org/abs/2010.11929
    """
    return re.sub(r"v\d+$", "", url)


async def search(source: ParsedSource) -> MatchResult | None:
    """Search arXiv — direct ID lookup first, title search as fallback.

    When the reference text already contains an arXiv URL
    (e.g. https://arxiv.org/abs/2010.11929) we extract the ID and call the
    arXiv API with ``id_list`` for a guaranteed exact match, bypassing the
    fragile title-based Lucene query entirely.  This is by far the most
    common case for arXiv citations and produces a score of 1.0 via the
    arXiv-ID branch of ``_url_match_score`` in match_scorer.py.

    The title search is kept as a fallback for references that cite an arXiv
    paper without including its URL.

    Rate limiting: arXiv recommends ≤ 3 req/s.  With up to 3 sources
    verified in parallel each triggering an id_list lookup, un-throttled
    concurrent requests cause the API to return empty responses silently.
    The rate_limiter serialises calls to export.arxiv.org at 0.5 s gaps
    (~2/s), preventing that failure mode.
    """
    # Throttle before any network activity.
    await rate_limiter.acquire("export.arxiv.org")

    try:
        async with aiohttp.ClientSession(timeout=get_client_timeout()) as session:
            # ── Priority 1: direct lookup by embedded arXiv ID ──────────────
            arxiv_id = extract_arxiv_id(source.url or "") or extract_arxiv_id(
                source.raw_text
            )
            if arxiv_id:
                # Strip any version suffix so the API returns the canonical
                # record; the scored URL will also be version-free.
                base_id = re.sub(r"v\d+$", "", arxiv_id)
                result = await _lookup_by_id(session, base_id, source)
                if result:
                    return result

            # ── Priority 2: title-based search ──────────────────────────────
            if not (source.title or source.raw_text):
                return None

            best = await _fetch_best_match(
                session, _build_arxiv_query(source, with_author=True), source
            )

            # Fallback: author filter may be wrong, retry without it.
            if best is None:
                best = await _fetch_best_match(
                    session, _build_arxiv_query(source, with_author=False), source
                )

            return best
    except Exception:
        return None


async def _lookup_by_id(
    session: aiohttp.ClientSession,
    arxiv_id: str,
    source: ParsedSource,
) -> MatchResult | None:
    """Fetch a single arXiv paper by its ID using the id_list parameter."""
    try:
        params = {"id_list": arxiv_id}
        async with session.get(ARXIV_API, params=params) as resp:
            if resp.status != 200:
                return None
            text = await resp.text()
            return _parse_atom_response(text, source)
    except Exception:
        return None


async def _fetch_best_match(
    session: aiohttp.ClientSession,
    search_query: str,
    source: ParsedSource,
) -> MatchResult | None:
    """Execute one arXiv title-search request and return the best match."""
    try:
        params = {
            "search_query": search_query,
            "max_results": "5",
        }
        async with session.get(ARXIV_API, params=params) as resp:
            if resp.status != 200:
                return None
            text = await resp.text()
            return _parse_atom_response(text, source)
    except Exception:
        return None


def _parse_atom_response(xml_text: str, source: ParsedSource) -> MatchResult | None:
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError:
        return None

    entries = root.findall("atom:entry", NS)
    best: MatchResult | None = None

    search_query = source.raw_text[:100] if source.raw_text else (source.title or "")

    for entry in entries[:5]:
        title_el = entry.find("atom:title", NS)
        title = (
            (title_el.text or "").strip().replace("\n", " ")
            if title_el is not None
            else ""
        )

        authors = []
        for author in entry.findall("atom:author", NS):
            name_el = author.find("atom:name", NS)
            if name_el is not None and name_el.text:
                authors.append(name_el.text.strip())

        published = entry.find("atom:published", NS)
        year = None
        if published is not None and published.text:
            try:
                year = int(published.text[:4])
            except ValueError:
                pass

        # Prefer the text/html link (abstract page); fall back to atom:id.
        link = ""
        for link_el in entry.findall("atom:link", NS):
            if link_el.get("type") == "text/html":
                link = link_el.get("href", "")
                break
        if not link:
            id_el = entry.find("atom:id", NS)
            link = (id_el.text or "") if id_el is not None else ""

        # Strip version suffix so URL comparison in _url_match_score works
        # regardless of whether the source citation includes a version or not.
        # e.g. https://arxiv.org/abs/2010.11929v2 → https://arxiv.org/abs/2010.11929
        link = _strip_arxiv_version(link)

        candidate: dict[str, object] = {
            "database": "arXiv",
            "title": title,
            "authors": authors,
            "year": year,
            "doi": None,
            "journal": "arXiv",
            "url": link,
            "search_url": f"https://arxiv.org/search/?query={quote(search_query)}&searchtype=all",
        }

        match = score_match(source, candidate)
        if match and (best is None or match.score > best.score):
            best = match

    return best
