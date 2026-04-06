"""Meta search engine verifier - DuckDuckGo HTML lite as tier-2 fallback.

DuckDuckGo uses HTML lite (no API key needed, reliable).
"""

import re
from urllib.parse import quote, unquote

import aiohttp

from models.source import ParsedSource
from models.verification_result import MatchResult
from services.match_scorer import score_match
from services.search_settings import get_client_timeout
from utils.text_cleaning import clean_reference_text

_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
}


def _clean_query(raw_text: str) -> str:
    """Clean raw citation text for use as a search query."""
    cleaned = clean_reference_text(raw_text)
    return cleaned[:300]


# --- DuckDuckGo ---

async def search_duckduckgo(
    source: ParsedSource,
) -> MatchResult | None:
    """Search DuckDuckGo HTML lite."""
    query = source.title or _clean_query(source.raw_text) if source.raw_text else None
    if not query:
        return None

    search_url = f"https://duckduckgo.com/?q={quote(query)}"

    try:
        async with aiohttp.ClientSession(timeout=get_client_timeout()) as session:
            async with session.get(
                "https://html.duckduckgo.com/html/",
                params={"q": query},
                headers=_HEADERS,
            ) as resp:
                if resp.status != 200:
                    return None
                html = await resp.text()
                return _parse_ddg_results(html, source, search_url)
    except Exception:
        return None


def _parse_ddg_results(
    html: str, source: ParsedSource, search_url: str
) -> MatchResult | None:
    """Parse DuckDuckGo HTML lite results."""
    # Extract result links: <a class="result__a" href="...">Title</a>
    link_pattern = re.compile(
        r'class="result__a"[^>]*href="([^"]*)"[^>]*>(.*?)</a>', re.DOTALL
    )
    # Extract snippets: <a class="result__snippet" ...>text</a>
    snippet_pattern = re.compile(
        r'class="result__snippet"[^>]*>(.*?)</[at]', re.DOTALL
    )

    links = link_pattern.findall(html)
    snippets = snippet_pattern.findall(html)

    if not links:
        return None

    best: MatchResult | None = None
    for i, (raw_url, raw_title) in enumerate(links[:10]):
        title = re.sub(r"<[^>]+>", "", raw_title).strip()
        snippet = re.sub(r"<[^>]+>", "", snippets[i]).strip() if i < len(snippets) else ""

        # Decode DDG redirect URL
        url = raw_url
        url_match = re.search(r"uddg=([^&]+)", raw_url)
        if url_match:
            url = unquote(url_match.group(1))

        # Try to extract year from snippet or title
        year = None
        for text in [snippet, title]:
            m = re.search(r"\b(19|20)\d{2}\b", text)
            if m:
                year = int(m.group())
                break

        # Try to extract DOI from URL or snippet
        doi = None
        doi_match = re.search(r"(10\.\d{4,9}/[^\s,;\"'}\]]+)", url + " " + snippet)
        if doi_match:
            doi = doi_match.group(1).rstrip(".,;:)]}\"'")

        candidate = {
            "database": "DuckDuckGo",
            "title": title,
            "authors": [],
            "year": year,
            "doi": doi,
            "journal": "",
            "url": url,
            "search_url": search_url,
        }

        match = score_match(source, candidate)
        if match and (best is None or match.score > best.score):
            best = match

    return best
