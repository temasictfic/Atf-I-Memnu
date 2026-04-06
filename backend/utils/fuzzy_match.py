"""Fuzzy matching utilities."""

from rapidfuzz import fuzz


def title_similarity(title_a: str, title_b: str) -> float:
    """Calculate fuzzy similarity between two titles (0.0 - 1.0)."""
    if not title_a or not title_b:
        return 0.0
    return fuzz.token_sort_ratio(title_a.lower(), title_b.lower()) / 100.0


def author_name_match(name_a: str, name_b: str) -> bool:
    """Check if two author names likely refer to the same person."""
    return fuzz.ratio(name_a.lower(), name_b.lower()) > 80
