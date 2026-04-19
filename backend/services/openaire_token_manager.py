"""OpenAIRE refresh-token exchange and short-lived access-token cache.

Anonymous OpenAIRE is capped at 60 req/hour (one call per minute sliding
window) which is nowhere near enough for a 40-PDF batch. A registered user
can lift that cap to 7,200 req/hour by pasting a refresh token into Settings.

Refresh tokens expire 1 month after issuance; access tokens expire 1 hour.
We therefore:

- persist only the **refresh token** (in `settings.api_keys["openaire"]`),
- exchange it lazily for an access token on demand, cached in memory until
  60 s before expiry,
- if the exchange response rotates the refresh token (OpenAIRE's docs
  indicate this can happen), write the new one back to settings and bump
  `openaire_token_saved_at` so the UI warns at the correct time.

The verifier calls :func:`get_access_token` before each request and falls
back to anonymous if it returns ``None`` — the app stays usable even when
the user has not connected, has typo'd their token, or OpenAIRE is down.
"""

import asyncio
import time
from datetime import datetime, timezone

import aiohttp

REFRESH_ENDPOINT = (
    "https://services.openaire.eu/uoa-user-management/api/users/getAccessToken"
)

# Safety margin: treat the cached access token as expired a minute before
# OpenAIRE claims, so we never emit a request with a token that dies mid-flight.
_EXPIRY_SAFETY_MARGIN_SECONDS = 60.0

_cache_lock = asyncio.Lock()
_cached_access_token: str | None = None
_cached_expires_at: float = 0.0  # monotonic seconds; 0 = "no cache"


def invalidate_cache() -> None:
    """Drop the cached access token.

    Called when the refresh token is replaced (user pasted a new one, or
    disconnected) so the next verifier request re-exchanges instead of
    reusing a token bound to a token the user just invalidated.
    """
    global _cached_access_token, _cached_expires_at
    _cached_access_token = None
    _cached_expires_at = 0.0


async def exchange_refresh_token(
    refresh_token: str, *, timeout: float = 10.0
) -> dict:
    """Exchange a refresh token for a fresh access token.

    Returns the parsed JSON response. Raises :class:`RuntimeError` with a
    human-readable message on HTTP errors, timeouts, or malformed responses
    so the caller can forward the text to the UI.
    """
    params = {"refreshToken": refresh_token}
    try:
        async with aiohttp.ClientSession(
            timeout=aiohttp.ClientTimeout(total=timeout)
        ) as session:
            async with session.get(REFRESH_ENDPOINT, params=params) as resp:
                if resp.status == 401 or resp.status == 403:
                    raise RuntimeError(
                        "OpenAIRE rejected the refresh token "
                        "(expired or mistyped)."
                    )
                if resp.status != 200:
                    body = (await resp.text())[:200]
                    raise RuntimeError(
                        f"OpenAIRE returned HTTP {resp.status}: {body}"
                    )
                data = await resp.json(content_type=None)
                if not isinstance(data, dict) or "access_token" not in data:
                    raise RuntimeError(
                        "OpenAIRE response missing access_token field."
                    )
                return data
    except asyncio.TimeoutError as exc:
        raise RuntimeError("Timed out contacting OpenAIRE.") from exc
    except aiohttp.ClientError as exc:
        raise RuntimeError(f"Network error contacting OpenAIRE: {exc}") from exc


async def _refresh_and_cache(refresh_token: str) -> str | None:
    """Call OpenAIRE, update the in-memory cache, and persist rotated tokens.

    Returns the new access token on success, ``None`` on any error (the
    caller falls back to anonymous). Errors are swallowed here — the verifier
    path should never raise just because auth glue hiccupped.
    """
    global _cached_access_token, _cached_expires_at
    try:
        data = await exchange_refresh_token(refresh_token)
    except RuntimeError:
        return None

    access_token = data.get("access_token")
    if not isinstance(access_token, str) or not access_token:
        return None

    # OpenAIRE advertises expires_in in seconds (usually 3600). Be defensive —
    # accept str or int, fall back to 55 min if the field is missing or
    # malformed, which still leaves us a full 5-minute safety buffer.
    raw_expires = data.get("expires_in", 3600)
    try:
        expires_in = float(raw_expires)
    except (TypeError, ValueError):
        expires_in = 3300.0

    _cached_access_token = access_token
    _cached_expires_at = (
        time.monotonic() + max(expires_in - _EXPIRY_SAFETY_MARGIN_SECONDS, 30.0)
    )

    # OpenAIRE may rotate the refresh token. Persist the new one so the user
    # doesn't hit an unexpected sign-out next month. Imported inline to avoid
    # a circular dependency with the settings API module at process start.
    new_refresh = data.get("refresh_token")
    if isinstance(new_refresh, str) and new_refresh and new_refresh != refresh_token:
        try:
            from api.settings import get_current_settings, _save_settings
            current = get_current_settings()
            updated_keys = dict(current.api_keys)
            updated_keys["openaire"] = new_refresh
            updated = current.model_copy(update={
                "api_keys": updated_keys,
                "openaire_token_saved_at": datetime.now(timezone.utc)
                .date()
                .isoformat(),
            })
            _save_settings(updated)
        except Exception:
            # Persistence failure is non-fatal: we still have a valid access
            # token in memory. The worst case is the user re-paste next month.
            pass

    return access_token


async def get_access_token() -> str | None:
    """Return a valid OpenAIRE access token, or ``None`` if unavailable.

    Resolves the current refresh token from app settings each call so a
    user's disconnect/reconnect during the session takes effect immediately.
    """
    # Resolving settings inline keeps this module import-safe before the
    # FastAPI app has finished wiring its settings router.
    try:
        from api.settings import get_current_settings
        refresh_token = (
            get_current_settings().api_keys.get("openaire", "") or ""
        ).strip()
    except Exception:
        return None

    if not refresh_token:
        return None

    async with _cache_lock:
        if (
            _cached_access_token
            and time.monotonic() < _cached_expires_at
        ):
            return _cached_access_token
        return await _refresh_and_cache(refresh_token)
