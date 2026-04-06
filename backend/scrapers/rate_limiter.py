"""Per-domain rate limiter using token bucket algorithm."""

import asyncio
import time


class RateLimiter:
    def __init__(self):
        self._buckets: dict[str, dict] = {}
        self._lock = asyncio.Lock()

        # Default rates: seconds between requests
        self._rates = {
            "scholar.google.com": 2.0,
            # arXiv API recommends max 3 req/s; 0.5s gap keeps us safely at 2/s
            "export.arxiv.org": 0.5,
        }
        self._default_rate = 2.0

    async def acquire(self, domain: str):
        """Wait until a request can be made to this domain."""
        rate = self._rates.get(domain, self._default_rate)

        async with self._lock:
            bucket = self._buckets.get(domain)
            now = time.monotonic()

            if bucket is None:
                self._buckets[domain] = {"last_request": now}
                return

            elapsed = now - bucket["last_request"]
            if elapsed < rate:
                wait_time = rate - elapsed
                self._buckets[domain]["last_request"] = now + wait_time
            else:
                self._buckets[domain]["last_request"] = now
                return

        # Wait outside the lock
        if elapsed < rate:
            await asyncio.sleep(rate - elapsed)


rate_limiter = RateLimiter()
