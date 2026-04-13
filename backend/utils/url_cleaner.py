"""Repair URLs that were split across PDF line wraps.

PDF text extraction inserts a literal space at every line break. When a URL
wraps a line the space lands inside the URL — almost always right after a
hyphen or slash. NER and regex extractors both happily keep that space,
producing dead URLs like `https://eur- lex.europa.eu/...`.

This module rejoins wrap-broken pieces without gluing genuine trailing prose
(`hdl.handle.net/2142/121447, Son`) onto the URL.
"""

import re

_URL_START = re.compile(r"https?://", re.IGNORECASE)
_URL_TOKEN_CHARS = re.compile(r"^[A-Za-z0-9._~:/?#\[\]@!$&'()*+,;=%\-]+$")
_URL_SEPARATORS = re.compile(r"[./\-_]")
_TRAILING_PUNCT = ".,;:)]}\"'"


def clean_extracted_url(text: str | None) -> str | None:
    """Normalize a URL string that may contain PDF wrap-induced spaces."""
    if not text:
        return None
    m = _URL_START.search(text)
    if not m:
        return None
    tokens = text[m.start():].split()
    if not tokens:
        return None

    url = tokens[0]
    for tok in tokens[1:]:
        if not _URL_TOKEN_CHARS.fullmatch(tok):
            break
        # Trailing "-" is almost always a wrap point — URLs rarely end on a
        # hyphen — so accept any URL-shaped continuation. For other ambiguous
        # endings (slash, query separators) require the continuation to
        # itself contain a URL separator, otherwise we'd glue prose like
        # "/ 23" onto the URL.
        if url.endswith("-"):
            url += tok
        elif url.endswith(("/", "_", "=", "?", "&")):
            if _URL_SEPARATORS.search(tok):
                url += tok
            else:
                break
        else:
            break

    url = url.rstrip(_TRAILING_PUNCT)
    return url or None


def find_first_url(text: str | None) -> str | None:
    """Find the first URL in free text, repairing wrap breaks."""
    if not text:
        return None
    m = _URL_START.search(text)
    if not m:
        return None
    return clean_extracted_url(text[m.start():])
