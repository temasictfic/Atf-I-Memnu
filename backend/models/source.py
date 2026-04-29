import re

from pydantic import BaseModel


class BoundingBox(BaseModel):
    x0: float
    y0: float
    x1: float
    y1: float
    page: int


class SourceRectangle(BaseModel):
    id: str
    pdf_id: str
    bbox: BoundingBox
    bboxes: list[BoundingBox] = []  # multi-page: one bbox per page
    text: str
    ref_number: int | None = None
    status: str = "detected"  # detected, edited, approved


_DOI_FROM_URL = re.compile(r"https?://doi\.org/(10\.\S+)")
_ARXIV_FROM_URL = re.compile(r"https?://arxiv\.org/abs/([\w./-]+)")


class ParsedSource(BaseModel):
    """Structured fields extracted from raw source text."""
    raw_text: str
    title: str = ""
    authors: list[str] = []
    year: int | None = None
    url: str | None = None  # doi/arxiv built URL or first extracted URL
    journal: str | None = None  # journal/conference/publisher name
    citation_format: str | None = None  # "APA", "MLA", "Chicago", "Harvard", "Vancouver", "IEEE"
    extraction_method: str = "regex"  # "regex" or "ner"
    parse_confidence: float = 0.0

    @property
    def doi(self) -> str | None:
        """Extract DOI from url for backward compatibility with verification code."""
        if self.url:
            m = _DOI_FROM_URL.match(self.url)
            if m:
                return m.group(1).rstrip(".,;:)]}\"'")
        return None

    @property
    def arxiv_id(self) -> str | None:
        """Extract arXiv ID from url for backward compatibility with verification code."""
        if self.url:
            m = _ARXIV_FROM_URL.match(self.url)
            if m:
                return m.group(1)
        return None
