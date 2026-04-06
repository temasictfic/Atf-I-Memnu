"""Base class for all academic database verifiers."""

from abc import ABC, abstractmethod

from models.source import ParsedSource
from models.verification_result import MatchResult


class CaptchaError(Exception):
    """Raised when a database query is blocked by a CAPTCHA."""
    pass


class BlockedError(Exception):
    """Raised when access is blocked (e.g. no institutional subscription)."""
    pass


class AbstractVerifier(ABC):
    name: str = ""
    tier: int = 1  # 1 = API, 2 = meta-search
    base_url: str = ""

    @abstractmethod
    async def search(self, source: ParsedSource) -> MatchResult | None:
        """Search this database for the given source. Returns best match or None."""
        pass

    def build_search_url(self, query: str) -> str:
        """Build an external search URL for linking in UI."""
        return self.base_url
