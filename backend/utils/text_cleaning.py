"""Text cleaning utilities for reference processing."""

import re
import unicodedata


def normalize_text(text: str) -> str:
    """Normalize Unicode text for comparison."""
    text = unicodedata.normalize("NFKD", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def clean_reference_text(text: str) -> str:
    """Clean a reference text for search queries."""
    # Remove reference number prefix
    text = re.sub(r"^\s*\[?\d{1,3}\]?[.\)]\s*", "", text)
    # Remove URLs
    text = re.sub(r"https?://\S+", "", text)
    # Remove DOIs
    text = re.sub(r"10\.\d{4,9}/\S+", "", text)
    # Remove access dates in Turkish
    text = re.sub(r"Erişim\s+Tarihi[:\s]*\d{1,2}[./]\d{1,2}[./]\d{2,4}", "", text, flags=re.IGNORECASE)
    # Normalize whitespace
    text = re.sub(r"\s+", " ", text).strip()
    return text
