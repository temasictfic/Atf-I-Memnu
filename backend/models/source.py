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


class ParsedSource(BaseModel):
    """Structured fields extracted from raw reference text."""
    raw_text: str
    title: str = ""
    authors: list[str] = []
    year: int | None = None
    doi: str | None = None
    url: str | None = None
    journal: str | None = None
    citation_format: str | None = None  # "APA", "MLA", "Chicago", "Harvard", "Vancouver", "IEEE"
    parse_confidence: float = 0.0
