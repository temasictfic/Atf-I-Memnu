"""URL liveness checking for non-DOI/arXiv links in references.

DOI and arXiv URLs are validated via their respective APIs (Crossref, arXiv),
so we skip them here.  For all other URLs we send a HEAD (then GET as fallback)
and treat any response with status < 400 as alive.
"""

import asyncio
import logging

import aiohttp

logger = logging.getLogger(__name__)

_HEADERS = {
    "User-Agent": "AtfiMemnu/1.0 (Citation Verification; mailto:atfimemnu@example.com)",
    "Accept": "*/*",
}


def is_doi_or_arxiv_url(url: str) -> bool:
    """Return True if the URL points to doi.org or arxiv.org."""
    if not url:
        return False
    lower = url.lower()
    return "doi.org" in lower or "arxiv.org" in lower


async def _check_url_with_session(session: aiohttp.ClientSession, url: str) -> bool:
    """Check liveness of a single URL using a shared session.

    Tries HEAD first; falls back to GET if the server rejects HEAD or returns
    a non-2xx/3xx status. Returns False on any network error or timeout.
    """
    if not url or not url.startswith(("http://", "https://")):
        return False

    try:
        # HEAD attempt
        try:
            async with session.head(url, allow_redirects=True) as resp:
                if resp.status < 400:
                    return True
                # Some servers return 405/403 for HEAD — fall back to GET
                if resp.status not in (405, 403, 404):
                    return False
        except aiohttp.ClientError:
            pass

        # GET fallback
        try:
            async with session.get(url, allow_redirects=True) as resp:
                return resp.status < 400
        except aiohttp.ClientError:
            return False
    except asyncio.TimeoutError:
        logger.debug("URL liveness timeout: %s", url)
        return False
    except Exception as e:
        logger.debug("URL liveness error for %s: %s", url, e)
        return False


async def check_urls(urls: list[str], timeout: float = 10.0) -> dict[str, bool]:
    """Check liveness of multiple URLs in parallel.

    DOI/arXiv URLs are skipped (validated separately by API verifiers).
    Returns {url: alive} for the URLs that were actually checked.

    A single aiohttp.ClientSession is shared across all URLs in this call so
    we reuse the connection pool instead of paying a TLS handshake per URL.
    """
    targets = [u for u in urls if u and not is_doi_or_arxiv_url(u)]
    if not targets:
        return {}

    client_timeout = aiohttp.ClientTimeout(total=timeout)
    async with aiohttp.ClientSession(timeout=client_timeout, headers=_HEADERS) as session:
        results = await asyncio.gather(
            *(_check_url_with_session(session, u) for u in targets),
            return_exceptions=True,
        )

    out: dict[str, bool] = {}
    for url, alive in zip(targets, results):
        out[url] = bool(alive) if not isinstance(alive, Exception) else False
    return out
