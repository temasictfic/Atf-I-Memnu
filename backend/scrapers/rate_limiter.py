"""Per-domain rate limiter using token bucket algorithm."""

import asyncio
import time


class RateLimiter:
    def __init__(self):
        self._buckets: dict[str, dict] = {}
        self._parked_until: dict[str, float] = {}
        self._lock = asyncio.Lock()

        # Default rates: seconds between requests per host.
        # Tuned to stay under each API's documented unauthenticated limit
        # with 3 concurrent sources making sequential requests. Users with
        # API keys get higher effective throughput because the keyed call
        # path on S2 / PubMed is already well under the paced rate.
        self._rates = {
            "scholar.google.com": 2.0,
            # arXiv API User's Manual explicitly asks for ≤1 req / 3 s.
            # Earlier we used 1.5 s to minimize pacing latency, but under
            # sustained 3-way source concurrency Fastly still fingerprints
            # and 429s us — 3.0 s is the only rate that actually respects
            # the documented cap.
            "export.arxiv.org": 3.0,
            # Semantic Scholar anonymous pool is a *globally shared* bucket
            # (not per-IP), so pacing alone can't fully prevent 429s — the
            # only real fix is an API key. 2.0 s reduces the frequency.
            "api.semanticscholar.org": 2.0,
            # NCBI E-utilities: 3 req/s unauthenticated. 0.4 s ≈ 2.5/s.
            "eutils.ncbi.nlm.nih.gov": 0.4,
            # Crossref public pool: 5 req/s (the x-rate-limit-limit header).
            # Variant fallbacks inside one source can fire multiple calls,
            # so 0.25 s (4/s) keeps the whole fleet under the ceiling.
            "api.crossref.org": 0.25,
            # OpenAlex polite pool: 10 req/s advertised. 0.15 s ≈ 6.6/s
            # gives headroom for Cloudflare's burst shaping.
            "api.openalex.org": 0.15,
            # CORE free tier: 10 req/minute — one of the strictest limits
            # of any DB we hit. 6 s is the only rate that actually respects
            # their published cap.
            "api.core.ac.uk": 6.0,
        }
        self._default_rate = 2.0

    def park(self, domain: str, seconds: float) -> None:
        """Park a domain for ``seconds``, blocking new acquires until expiry.

        Called when a verifier observes a 429 response; honors the server's
        Retry-After so subsequent requests back off instead of pounding the
        same rate limit. Re-parking with a longer window extends; a shorter
        window is ignored so an earlier 429 can't be shortened by a later
        polite response.
        """
        if seconds <= 0:
            return
        expiry = time.monotonic() + seconds
        current = self._parked_until.get(domain, 0.0)
        if expiry > current:
            self._parked_until[domain] = expiry

    def parked_remaining(self, domain: str) -> float:
        """Return seconds remaining on a park window (0.0 if not parked)."""
        expiry = self._parked_until.get(domain)
        if expiry is None:
            return 0.0
        remaining = expiry - time.monotonic()
        if remaining <= 0:
            self._parked_until.pop(domain, None)
            return 0.0
        return remaining

    async def acquire(self, domain: str):
        """Wait for the inter-request pacing window for this domain.

        Note: parks (from 429 / Retry-After) are *not* waited out here.
        Sleeping through a multi-second park would push the verifier past
        its per-DB search timeout and turn a transient rate limit into a
        hard failure. Parks are instead enforced by ``check_parked_url``
        at each request site, which fails fast so the source is marked
        ``rate_limited`` immediately and the next DB can proceed.
        """
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
