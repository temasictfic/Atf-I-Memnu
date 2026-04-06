"""Helpers for reading effective search runtime settings."""

import aiohttp

from api.settings import get_current_settings
from config import settings as app_config


def get_search_timeout_seconds() -> int:
    """Return effective per-search timeout in seconds from persisted settings."""
    try:
        configured = int(get_current_settings().search_timeout)
    except Exception:
        configured = int(app_config.search_timeout)
    return max(5, min(configured, 300))


def get_max_concurrent_apis() -> int:
    """Return effective API concurrency limit from persisted settings."""
    try:
        configured = int(get_current_settings().max_concurrent_apis)
    except Exception:
        configured = int(app_config.max_concurrent_apis)
    return max(1, min(configured, 50))


def get_max_concurrent_sources_per_pdf() -> int:
    """Return effective source-level concurrency limit for one PDF."""
    try:
        configured = int(get_current_settings().max_concurrent_sources_per_pdf)
    except Exception:
        configured = int(app_config.max_concurrent_sources_per_pdf)
    return max(1, min(configured, 20))


def get_client_timeout(multiplier: float = 1.0) -> aiohttp.ClientTimeout:
    """Build an aiohttp timeout using the effective search timeout."""
    total = int(round(get_search_timeout_seconds() * max(multiplier, 0.1)))
    return aiohttp.ClientTimeout(total=max(5, min(total, 300)))
