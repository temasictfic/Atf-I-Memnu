"""Base class for all academic database verifiers."""

from abc import ABC, abstractmethod

from models.source import ParsedSource
from models.verification_result import MatchResult


class AbstractVerifier(ABC):
    name: str = ""
    base_url: str = ""

    @abstractmethod
    async def search(self, source: ParsedSource) -> MatchResult | None:
        """Search this database for the given source. Returns best match or None."""
        pass
