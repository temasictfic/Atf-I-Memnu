"""Extract and normalize DOIs from reference text."""

import re

DOI_BODY_PATTERN = r"10\.\d{4,9}/[A-Za-z0-9._;()/:+\-]+(?:\s+[A-Za-z0-9._;()/:+\-]+)*"

DOI_PATTERNS = [
    # Kurallar DOI Rule 4: "doi:" or "doi.org" format
    re.compile(rf"doi[:\s]+\s*({DOI_BODY_PATTERN})", re.IGNORECASE),
    # Kurallar DOI Rule 4: URL format
    re.compile(rf"https?://(?:dx\.)?doi\.org/({DOI_BODY_PATTERN})", re.IGNORECASE),
    # Kurallar DOI Rule 1-2: bare DOI pattern (linked or numbered)
    re.compile(rf"({DOI_BODY_PATTERN})"),
]

ARXIV_PATTERNS = [
    re.compile(r"10\.48550/arxiv\.(\d{4}\.\d{4,5}(?:v\d+)?)", re.IGNORECASE),
    re.compile(r"arxiv\.org/(?:abs|pdf)/(\d{4}\.\d{4,5}(?:v\d+)?)", re.IGNORECASE),
    re.compile(r"arXiv[:\s]*(\d{4}\.\d{4,5}(?:v\d+)?)", re.IGNORECASE),
]


def extract_doi(text: str) -> str | None:
    """Extract a DOI from text, if present."""
    for pattern in DOI_PATTERNS:
        match = pattern.search(text)
        if match:
            return normalize_doi(match.group(1))
    return None


def normalize_doi(doi: str) -> str:
    """Normalize DOI for consistent comparison."""
    doi = doi.strip().lower()
    # Remove URL prefix
    doi = re.sub(r"^https?://(?:dx\.)?doi\.org/", "", doi)
    # Remove "doi:" prefix
    doi = re.sub(r"^doi:\s*", "", doi)
    # Remove accidental whitespace within DOI body (OCR/wrapped text)
    doi = re.sub(r"\s+", "", doi)
    # Strip trailing punctuation
    doi = doi.rstrip(".,;:)]}\"'")
    return doi


def extract_arxiv_id(text: str) -> str | None:
    """Extract arXiv ID from URL or text."""
    for pattern in ARXIV_PATTERNS:
        match = pattern.search(text)
        if match:
            return match.group(1)
    return None
