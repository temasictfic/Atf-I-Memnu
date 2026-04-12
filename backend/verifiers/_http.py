"""Shared aiohttp session for verifier HTTP calls.

Verifiers historically opened a fresh `aiohttp.ClientSession` on every call,
which defeats TCP connection pooling and repeats the TLS handshake for every
citation. This module exposes a single lazily-created session that is reused
across calls, and a shutdown hook the FastAPI app can wire into lifespan.
"""

import aiohttp

from services.search_settings import get_client_timeout

_session: aiohttp.ClientSession | None = None


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
