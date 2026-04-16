"""Fuzzy matching utilities."""

from rapidfuzz import fuzz


def title_similarity(title_a: str, title_b: str) -> float:
    """Calculate fuzzy similarity between two titles (0.0 - 1.0).

    Blends order-insensitive (token_sort_ratio) with order-sensitive (ratio)
    so that reordered titles still match but don't score as high as exact matches.
    """
    if not title_a or not title_b:
        return 0.0
    a, b = title_a.lower(), title_b.lower()
    token_sort = fuzz.token_sort_ratio(a, b) / 100.0
    sequential = fuzz.ratio(a, b) / 100.0
    return 0.6 * token_sort + 0.4 * sequential


def author_name_match(name_a: str, name_b: str) -> bool:
    """Check if two author names likely refer to the same person."""
    return fuzz.ratio(name_a.lower(), name_b.lower()) > 80
