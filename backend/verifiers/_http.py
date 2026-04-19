"""Shared aiohttp session for verifier HTTP calls.

Verifiers historically opened a fresh `aiohttp.ClientSession` on every call,
which defeats TCP connection pooling and repeats the TLS handshake for every
citation. This module exposes a single lazily-created session that is reused
across calls, and a shutdown hook the FastAPI app can wire into lifespan.
"""

from email.utils import parsedate_to_datetime
from datetime import datetime, timezone
from urllib.parse import urlparse

import aiohttp

from scrapers.rate_limiter import rate_limiter
from services.search_settings import get_client_timeout

_session: aiohttp.ClientSession | None = None


class RateLimitedError(Exception):
    """Raised when an upstream API returns HTTP 429.

    Carries the host and the server-advertised retry-after (in seconds)
    so the orchestrator can surface a distinct UI state and the rate
    limiter can park the host until the window elapses.
    """

    def __init__(self, host: str, retry_after: float | None = None, status: int = 429):
        self.host = host
        self.retry_after = retry_after
        self.status = status
        msg = f"{host} returned {status}"
        if retry_after is not None:
            msg += f" (retry-after {retry_after:.0f}s)"
        super().__init__(msg)


def _parse_retry_after(value: str | None) -> float | None:
    """Parse a Retry-After header. Accepts delta-seconds or HTTP-date."""
    if not value:
        return None
    value = value.strip()
    try:
        return max(0.0, float(value))
    except ValueError:
        pass
    try:
        dt = parsedate_to_datetime(value)
    except (TypeError, ValueError):
        return None
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    delta = (dt - datetime.now(timezone.utc)).total_seconds()
    return max(0.0, delta)


def check_parked_url(url: str) -> None:
    """Fail fast if the URL's host is currently parked by the rate limiter.

    Called at the top of each verifier request site. If an earlier 429
    parked this host, we raise ``RateLimitedError`` immediately with the
    remaining cooldown — no network round-trip, no extra 429, no waiting.
    The orchestrator turns that into a ``rate_limited`` UI state and the
    per-DB search for this source ends in milliseconds instead of burning
    the whole ``search_timeout`` asleep inside a rate limiter.
    """
    host = urlparse(url).hostname
    if not host:
        return
    remaining = rate_limiter.parked_remaining(host)
    if remaining > 0:
        raise RateLimitedError(host, retry_after=remaining, status=429)


def check_rate_limit(resp: aiohttp.ClientResponse) -> None:
    """Raise ``RateLimitedError`` if the response is a 429.

    Also parks the response's host in the shared rate limiter so subsequent
    requests back off for the server-advertised window (or a conservative
    default of 60s when no Retry-After header is present).
    """
    if resp.status != 429:
        return
    host = resp.url.host or ""
    retry_after = _parse_retry_after(resp.headers.get("Retry-After"))
    # Cap the park window so one rude server can't stall the app forever.
    # Default (no Retry-After header) is 10s — with the new stride-based
    # rotation that caps concurrent per-DB hits at 2 (down from 3), 429s
    # without a server-provided Retry-After are almost always transient
    # contention rather than a sustained quota breach, so a shorter park
    # lets subsequent sources in the same PDF retry sooner. A real quota
    # exhaustion still gets respected because the server will send its
    # own Retry-After value, which we honor verbatim up to the 900s cap.
    park_seconds = min(retry_after if retry_after is not None else 10.0, 900.0)
    if host:
        rate_limiter.park(host, park_seconds)
    raise RateLimitedError(host, retry_after, status=resp.status)


def get_session() -> aiohttp.ClientSession:
    """Return the process-wide verifier session, creating it on first use."""
    global _session
    if _session is None or _session.closed:
        _session = aiohttp.ClientSession(timeout=get_client_timeout())
    return _session


async def close_session() -> None:
    """Close the shared session. Call from app shutdown."""
    global _session
    if _session is not None and not _session.closed:
        await _session.close()
    _session = None
