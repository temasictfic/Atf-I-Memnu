"""Extract structured fields (title, authors, year, DOI, etc.) from raw reference text.

Implements rule-based parsing guided by Kurallar.xlsx:
- Sheet 1 "Veri": 12 parsing rules for field boundary detection
- Sheet 2 "Atif Formatlari": 6 citation format definitions (APA, MLA, Chicago, Harvard, Vancouver, IEEE)
"""

import re

from models.source import ParsedSource
from services.citation_format_detector import CitationFormat, detect_format
from utils.doi_extractor import extract_doi, extract_arxiv_id
from utils.text_cleaning import (
    YEAR_PATTERN,
    is_valid_year,
    normalize_author_conjunctions,
    strip_reference_noise,
)
from utils.url_cleaner import find_best_url


async def extract_source_fields(raw_text: str) -> ParsedSource:
    """Parse raw reference text into structured fields.

    Tries NER extraction first (GLiNER2), falls back to regex if NER is
    unavailable or returns low confidence.
    """
    from services.ner_extractor import extract_fields_ner

    # Strip leading reference numbering ("1-", "1.", "[1]", "1)") before
    # NER sees the text — otherwise the numeric prefix leaks into author
    # entity spans via raw_text offset reconstruction.
    cleaned_text = strip_reference_noise(raw_text)

    ner_result = await extract_fields_ner(cleaned_text)
    if ner_result is not None and ner_result.parse_confidence >= 0.3:
        return ner_result

    return _extract_source_fields_regex(cleaned_text)


def _extract_source_fields_regex(raw_text: str) -> ParsedSource:
    """Parse raw reference text into structured fields using rule-based, format-aware extraction."""
    result = ParsedSource(raw_text=raw_text)

    # Strip leading numbering and access-date noise before parsing fields.
    text = strip_reference_noise(raw_text)

    # Strip a leading inline parenthetical citation that some refs
    # duplicate before the real author list, e.g.
    #   "(Jenkins vd., 2024) Jenkins, A., ve diğerleri (2024). …"
    # The parenthetical confuses every downstream rule (boundary, year,
    # author pairing), so we remove it up front.
    text = re.sub(
        r"^\(\s*[^)]*?(?:vd|et\s+al|diğerleri)\.?\s*(?:,?\s*(?:19|20)\d{2})?\s*\)\s*",
        "",
        text,
        flags=re.IGNORECASE,
    )

    # Extract identifiers for URL building
    doi = extract_doi(text)
    arxiv_id = extract_arxiv_id(text)

    # Build URL: doi > arxiv > first extracted URL
    if doi:
        result.url = f"https://doi.org/{doi}"
    elif arxiv_id:
        result.url = f"https://arxiv.org/abs/{arxiv_id}"
    else:
        result.url = find_best_url(text)

    # Detect citation format
    fmt, fmt_confidence = detect_format(text)
    result.citation_format = fmt.value if fmt else None

    # Find author boundary using Kurallar rules
    author_end = _find_author_boundary(text, fmt)

    # Extract authors from the author section
    author_text = text[:author_end].strip().rstrip(",").rstrip(".")
    # Trailing year can leak into the author section when the boundary
    # detector stops at a title quote (e.g. IEEE book refs). Strip both
    # bare trailing years and parenthesized trailing years.
    author_text = re.sub(
        r"[\s.,]*\(?\s*(?:19|20)\d{2}[a-z]?\s*\)?\.?$", "", author_text
    ).strip().rstrip(",").rstrip(".")
    # Strip leading inline citations that some refs duplicate before the
    # real author list, e.g. "(Calazans vd. 2024) Calazans, M. A. A., ..."
    author_text = re.sub(
        r"^\(\s*[^)]*?(?:vd|et\s+al|diğerleri)\.?\s*(?:,?\s*(?:19|20)\d{2})?\s*\)\s*",
        "",
        author_text,
        flags=re.IGNORECASE,
    ).strip()
    # Strip quoted nicknames embedded in the author list, e.g.
    # `Um, E. "Rachel", Plass, J. L., ...`. The nickname confuses the
    # comma-split pairing; the "Rachel" span adds no signal for matching.
    author_text = re.sub(r'[\"\u201C][^\"\u201D]*[\"\u201D]', "", author_text)
    author_text = re.sub(r"\s+", " ", author_text).strip(" ,.")
    result.authors = _parse_authors(author_text, fmt)

    # Extract year (rule-based priority: parenthesized > post-conjunction > first-after-authors)
    result.year, year_start, year_end = _extract_year(text, author_end)

    # Extract title and source (journal/conference/publisher name)
    result.title, result.source = _extract_title_journal(text, author_end, year_start, year_end, fmt)

    # Compute confidence
    result.parse_confidence = _compute_parse_confidence(result)

    return result


# ---------------------------------------------------------------------------
# Author boundary detection (Kurallar Rules 4, 6, 7, 8, 9, 10, 11, 12)
# ---------------------------------------------------------------------------

def _find_author_boundary(text: str, fmt: CitationFormat | None) -> int:
    """Find the character index where the authors section ends.

    Uses Kurallar author rules to detect the boundary between authors and
    the rest of the reference (year, title, journal, etc.).
    """
    if not text:
        return 0

    # Format-specific overrides
    if fmt == CitationFormat.VANCOUVER:
        return _find_author_boundary_vancouver(text)
    if fmt == CitationFormat.IEEE:
        return _find_author_boundary_ieee(text)

    # Generic rule-based detection for APA/MLA/Chicago/Harvard and unknown formats

    # MLA/Chicago: authors end before a quoted title
    # Check if there's a ". " followed by a quote character, but only
    # if the quoted span looks like a title (several words) — not a
    # short nickname like Um, E. "Rachel", which some refs include
    # inside the author list.
    for qm in re.finditer(r'\.\s+["\u201C]', text):
        before = text[:qm.start() + 1]
        if not _looks_like_author_section(before):
            continue
        # Find the closing quote and measure word count inside.
        after_open = qm.end()
        close_m = re.search(r'["\u201D]', text[after_open:])
        if close_m:
            inside = text[after_open : after_open + close_m.start()].strip()
            if len(inside.split()) < 3:
                # Too short to be a title — likely a nickname inside authors.
                continue
        return qm.start() + 1

    # Rule 10 (Definite): ". (" = authors section ends (APA-style year in parens)
    # Look for ". (" or ".(" pattern — but only where "(" starts a year
    for m in re.finditer(r"\.\s*\(", text):
        pos = m.start()
        after_paren = text[m.end():]
        # Confirm it's a year in parens, not e.g. "(eds.)"
        if re.match(r"\d{4}", after_paren):
            return m.start() + 1  # include the period

    # Rule 8 (Definite): "., YYYY" = last author is right before year
    for m in re.finditer(r"\.,\s*(\d{4})", text):
        year_val = int(m.group(1))
        if is_valid_year(year_val):
            return m.start() + 1  # include the period

    # Rule 9 (Definite): ". YYYY" = last author is right before year
    for m in re.finditer(r"\.\s+(\d{4})", text):
        year_val = int(m.group(1))
        if is_valid_year(year_val):
            # Make sure this isn't in the middle of a title/journal
            # Check that the text before looks like author names
            before = text[:m.start() + 1]
            if _looks_like_author_section(before):
                return m.start() + 1

    # Rule 4 (Definite): ". , " side by side = end of authors section
    # UNLESS followed by &, and, ve, et al. (still in authors)
    for m in re.finditer(r"\.\s*,\s", text):
        pos = m.end()
        after = text[pos:pos + 40].strip()
        # Rule 4 exception: if followed by conjunction, still authors
        if re.match(r"(?:&|and\b|ve\b|et\s+al\.)", after, re.IGNORECASE):
            continue
        # Rule 6/12: if followed by ", K." pattern, still in authors
        if re.match(r"[A-ZÇĞİÖŞÜ]\.", after):
            continue
        # Extension: if followed by "Surname, Initial" (another author
        # in the list), the ". ," is NOT the end of the author section.
        # e.g. "Hinton, G., Deng, L., ..." — first ". ," sits between two authors.
        if re.match(
            r"[A-ZÇĞİÖŞÜ][a-zçğıöşü]+(?:-[A-ZÇĞİÖŞÜa-zçğıöşü]+)?\s*,\s*[A-ZÇĞİÖŞÜ]",
            after,
        ):
            continue
        return m.start() + 1

    # Fallback: find the first year and use text before it
    year_match = re.search(r"\((?:19|20)\d{2}[a-z]?\)", text)
    if year_match:
        return year_match.start()

    # Fallback: find first bare year
    year_match = YEAR_PATTERN.search(text)
    if year_match:
        # Go back to the preceding period or comma
        before = text[:year_match.start()]
        last_period = before.rfind(".")
        last_comma = before.rfind(",")
        boundary = max(last_period, last_comma)
        if boundary > 0:
            return boundary + 1

    # Last resort: use first 30% of text or first period
    first_period = text.find(".")
    if first_period > 0 and first_period < len(text) * 0.5:
        return first_period + 1

    return min(len(text), int(len(text) * 0.3))


def _find_author_boundary_vancouver(text: str) -> int:
    """Find author boundary for Vancouver format.

    Vancouver: "Shingjergji K, Iren D, Urlings C, Klemke R. Title..."
    Authors have no comma between last name and initials, no period after initials.
    The FIRST period in the text marks the end of the author section.
    """
    # In Vancouver format, there are NO periods within the author section.
    # The very first period is the author/title boundary.
    # Scan for "LastName INITIALS" groups separated by commas, ending with a period.
    # Pattern: sequence of "Word CAPS" separated by commas, terminated by "."
    m = re.match(
        r"((?:[A-Z][a-z]+\s[A-Z]{1,3}(?:\s[A-Z]{1,3})*,\s*)*"  # comma-separated authors
        r"[A-Z][a-z]+\s[A-Z]{1,3}(?:\s[A-Z]{1,3})*)"            # last author (no trailing comma)
        r"\.\s",                                                    # period = boundary
        text,
    )
    if m:
        return m.end() - 1  # include up to the period, position after "."

    # Fallback: first period in text
    first_period = text.find(".")
    if first_period > 5:
        return first_period + 1
    return min(len(text), int(len(text) * 0.3))


def _find_author_boundary_ieee(text: str) -> int:
    """Find author boundary for IEEE format.

    IEEE: "G. Liu, K. Y. Lee, and H. F. Jordan, \\"Title,\\" ..."
    Authors have initials first (G. Liu), and the transition to title
    is marked by a quoted string.
    """
    # Book/editor references often mark the transition with "Ed.," or "Eds.,"
    # and do not quote titles (e.g., "A. Author, Eds., Book Title...").
    editor_boundary = re.search(r",\s*(?:Ed\.|Eds\.|Editor|Editors),\s+", text, re.IGNORECASE)
    if editor_boundary:
        return editor_boundary.end()

    # Look for the start of a quoted title
    quote_match = re.search(r'[,\s]+["\u201C]', text)
    if quote_match:
        return quote_match.start()

    # Fallback: look for ", \"" pattern
    comma_quote = text.find(',"')
    if comma_quote > 0:
        return comma_quote

    # Fallback: walk comma-separated parts from the start and stop at
    # the first part that doesn't look like a name (first comma-separated
    # token containing 3+ words or a lowercase-initial word).
    offset = 0
    for part in text.split(","):
        stripped = part.strip()
        if not stripped:
            offset += len(part) + 1
            continue
        words = stripped.split()
        # Non-name heuristics: 3+ words, or starts with lowercase, or
        # the first word is a known title keyword.
        looks_like_name = (
            len(words) <= 3
            and words[0][0].isupper()
        )
        if not looks_like_name:
            return offset if offset > 0 else min(len(text), int(len(text) * 0.3))
        offset += len(part) + 1
    return min(len(text), int(len(text) * 0.3))


def _looks_like_author_section(text: str) -> bool:
    """Check if text looks like it contains author names."""
    # Should contain comma-separated names or single name
    # Quick heuristic: has at least one comma and uppercase letters
    return bool(re.search(r"[A-Z].*,", text)) or len(text) < 60


# ---------------------------------------------------------------------------
# Year extraction (Kurallar Rules 3, 4, 5, 6)
# ---------------------------------------------------------------------------

def _extract_year(text: str, author_end_pos: int) -> tuple[int | None, int, int]:
    """Extract year using Kurallar priority rules.

    Returns (year, start_pos, end_pos) in the original text.
    """
    # Rule 5 (Definite): Parenthesized year takes absolute priority.
    # Also handle variants like: (2013, 22 Aralik) or (2013, Dec 22).
    # We return the full parenthesized span so title extraction starts AFTER it.
    paren_year_with_tail = re.search(r"\((\d{4})[a-z]?(?:\s*,[^)]*)?\)", text, re.IGNORECASE)
    if paren_year_with_tail:
        year_val = int(paren_year_with_tail.group(1))
        if is_valid_year(year_val):
            return year_val, paren_year_with_tail.start(), paren_year_with_tail.end()

    # Rule 3 (Definite): Year after &, and, ve, et al.
    conj_year = re.search(
        r"(?:&|and|ve|et\s+al\.)\s*,?\s*(\d{4})\b", text, re.IGNORECASE
    )
    if conj_year:
        year_val = int(conj_year.group(1))
        if is_valid_year(year_val):
            return year_val, conj_year.start(1), conj_year.end(1)

    # Rule 4 (Definite): After conjunctions, if ( follows, year = 4 digits inside (
    conj_paren = re.search(
        r"(?:&|and|ve|et\s+al\.)\s*\((\d{4})", text, re.IGNORECASE
    )
    if conj_paren:
        year_val = int(conj_paren.group(1))
        if is_valid_year(year_val):
            return year_val, conj_paren.start(1), conj_paren.end(1)

    # Rule 6 (Definite): First 4-digit number after author_end_pos. Once found, stop.
    after_authors = text[author_end_pos:]
    first_year = YEAR_PATTERN.search(after_authors)
    if first_year:
        year_val = int(first_year.group(1))
        if is_valid_year(year_val):
            abs_start = author_end_pos + first_year.start(1)
            abs_end = author_end_pos + first_year.end(1)
            return year_val, abs_start, abs_end

    # Fallback: first year anywhere in text
    fallback = YEAR_PATTERN.search(text)
    if fallback:
        year_val = int(fallback.group(1))
        if is_valid_year(year_val):
            return year_val, fallback.start(1), fallback.end(1)

    return None, -1, -1


# ---------------------------------------------------------------------------
# Title & Journal extraction (format-aware, Kurallar Title/Journal rules)
# ---------------------------------------------------------------------------

def _extract_title_journal(
    text: str,
    author_end: int,
    year_start: int,
    year_end: int,
    fmt: CitationFormat | None,
) -> tuple[str, str | None]:
    """Extract title and journal using format-aware parsing.

    Kurallar Title Rule 1: If in quotes, extract quoted content.
    Kurallar Journal Rule 2: Journal comes after comma.
    Kurallar Journal Rule 5: Period after journal = end of journal name.
    """
    if fmt in (CitationFormat.APA, CitationFormat.HARVARD):
        return _extract_title_journal_apa_harvard(text, author_end, year_start, year_end)
    if fmt in (CitationFormat.MLA, CitationFormat.CHICAGO):
        return _extract_title_journal_mla_chicago(text, author_end, year_start, year_end)
    if fmt == CitationFormat.VANCOUVER:
        return _extract_title_journal_vancouver(text, author_end, year_start, year_end)
    if fmt == CitationFormat.IEEE:
        return _extract_title_journal_ieee(text, author_end, year_start, year_end)

    # Unknown format: use legacy approach
    return _extract_title_journal_legacy(text, author_end, year_start, year_end)


def _extract_title_journal_apa_harvard(
    text: str, author_end: int, year_start: int, year_end: int
) -> tuple[str, str | None]:
    """APA: Authors (Year). Title. Journal, Issue.
    Harvard: Authors Year. Title. Journal, Issue.
    Title comes AFTER year.
    """
    if year_end < 0:
        return _extract_title_journal_legacy(text, author_end, year_start, year_end)

    after_year = text[year_end:].strip().lstrip(".)].").strip()
    if not after_year:
        return "", None

    # Kurallar Title Rule 1: check for quoted title
    quoted = re.match(r'["\u201C]([^"\u201D]+)["\u201D]', after_year)
    if quoted:
        title = quoted.group(1).strip()
        remainder = after_year[quoted.end():].strip().lstrip(".,").strip()
        journal = _extract_journal_from_remainder(remainder)
        return title, journal

    # Title ends at first ". " followed by a capital letter (= journal start)
    parts = re.split(r"\.\s+(?=[A-Z])", after_year, maxsplit=1)
    title = parts[0].strip().rstrip(".")
    if len(parts) > 1:
        journal = _extract_journal_from_remainder(parts[1])
    else:
        journal = None

    return title, journal


def _extract_title_journal_mla_chicago(
    text: str, author_end: int, year_start: int, year_end: int
) -> tuple[str, str | None]:
    """MLA: Authors. "Title." Journal (Year): Issue.
    Chicago: Authors. "Title." Journal (Year): Issue.
    Title comes BEFORE year, after authors.
    """
    # The region between author_end and the year contains title + journal
    if year_start > author_end:
        between = text[author_end:year_start]
    else:
        between = text[author_end:]

    between = between.strip().lstrip(".,").strip()

    # Kurallar Title Rule 1: quoted title
    quoted = re.search(r'["\u201C]([^"\u201D]+)["\u201D]', between)
    if quoted:
        title = quoted.group(1).strip().rstrip(".")
        # Journal is between the end of the quote and the year
        after_quote = between[quoted.end():].strip().lstrip(".,").strip()
        journal = _extract_journal_from_remainder(after_quote) if after_quote else None
        return title, journal

    # No quotes: split by period
    parts = re.split(r"\.\s+(?=[A-Z])", between, maxsplit=1)
    title = parts[0].strip().lstrip(".,").strip().rstrip(".")
    if len(parts) > 1:
        journal = _extract_journal_from_remainder(parts[1])
    else:
        journal = None

    return title, journal


def _extract_title_journal_vancouver(
    text: str, author_end: int, year_start: int, year_end: int
) -> tuple[str, str | None]:
    """Vancouver: Authors. Title. Journal. Year;Issue.
    Title and journal are period-separated, both before year.
    """
    if year_start > author_end:
        between = text[author_end:year_start]
    else:
        between = text[author_end:]

    between = between.strip().lstrip(".,").strip()

    # Split by ". " — first segment is title, second is journal
    parts = re.split(r"\.\s+", between, maxsplit=2)
    title = parts[0].strip().rstrip(".") if parts else ""
    journal = parts[1].strip().rstrip(".") if len(parts) > 1 else None

    return title, journal


def _extract_title_journal_ieee(
    text: str, author_end: int, year_start: int, year_end: int
) -> tuple[str, str | None]:
    """IEEE: Authors, "Title," Journal, vol. Issue, Year.
    Title is in quotes (ending with ,"), journal follows.
    """
    after_authors = text[author_end:].strip().lstrip(",").strip()

    # Kurallar Title Rule 1 + IEEE specific: title in quotes ending with ,"
    quoted = re.search(r'["\u201C]([^"\u201D]+)["\u201D]', after_authors)
    if quoted:
        title = quoted.group(1).strip().rstrip(",").rstrip(".")
        remainder = after_authors[quoted.end():].strip().lstrip(",").strip()
        journal = _extract_journal_from_remainder(remainder)
        return title, journal

    # Fallback
    return _extract_title_journal_legacy(text, author_end, year_start, year_end)


def _extract_title_journal_legacy(
    text: str, author_end: int, year_start: int, year_end: int
) -> tuple[str, str | None]:
    """Legacy extraction when format is unknown. Preserved for backward compatibility."""
    # Try parenthesized year pattern: Authors (Year). Title. Journal
    year_paren_match = re.search(r"\((?:19|20)\d{2}[a-z]?\)", text)
    if year_paren_match:
        after_year = text[year_paren_match.end():].strip().lstrip(".").strip()
        # Check for quoted title
        title_match = re.match(r'"([^"]+)"', after_year)
        if title_match:
            title = title_match.group(1).strip()
            remainder = after_year[title_match.end():].strip().lstrip(".").strip()
            journal = _extract_journal_from_remainder(remainder)
            return title, journal
        # Title ends at ". " + capital letter
        parts = re.split(r"\.\s+(?=[A-Z])", after_year, maxsplit=1)
        title = parts[0].strip().rstrip(".")
        journal = _extract_journal_from_remainder(parts[1]) if len(parts) > 1 else None
        return title, journal

    # Try quoted title anywhere
    quote_match = re.search(r'"([^"]+)"', text)
    if quote_match:
        title = quote_match.group(1).strip()
        return title, None

    # Last resort: take text after author boundary, capped
    after = text[author_end:].strip().lstrip(".,()0123456789 ").strip()
    if after:
        # Split at first period for title
        parts = re.split(r"\.\s+", after, maxsplit=1)
        title = parts[0].strip().rstrip(".")[:200]
        journal = _extract_journal_from_remainder(parts[1]) if len(parts) > 1 else None
        return title, journal

    return text[:200], None


def _extract_journal_from_remainder(text: str) -> str | None:
    """Extract journal name from remaining text after title.

    Kurallar Journal Rule 2: after comma.
    Kurallar Journal Rule 4: journal name up to issue number.
    Kurallar Journal Rule 5: period after journal = end.
    """
    if not text or len(text.strip()) < 3:
        return None

    text = text.strip()

    # Journal ends at volume/issue patterns
    # Strip trailing issue info: ", vol. 45", ", 45(2)", ", pp. 123-145"
    journal_end = re.search(
        r",\s*(?:vol\.|pp\.|p\.|\d+\s*\(|\d+\s*$)", text, re.IGNORECASE
    )
    if journal_end:
        journal = text[:journal_end.start()].strip()
    else:
        # Kurallar Journal Rule 5: period = end of journal name
        journal = text.split(".")[0].strip()

    # Kurallar Journal Rule 2: if journal starts with comma, strip it
    journal = journal.strip(",").strip()

    # Remove DOI or URL remnants
    journal = re.sub(r"https?://\S+", "", journal).strip()
    journal = re.sub(r"doi[:\s]*10\.\S+", "", journal, flags=re.IGNORECASE).strip()

    if len(journal) < 3:
        return None

    return journal.rstrip(".,;:") or None


# ---------------------------------------------------------------------------
# Author parsing (format-aware)
# ---------------------------------------------------------------------------

def _parse_authors(author_text: str, fmt: CitationFormat | None = None) -> list[str]:
    """Parse author string into list of individual author names."""
    if not author_text:
        return []

    if fmt == CitationFormat.VANCOUVER:
        return _parse_vancouver_authors(author_text)

    # IEEE and all remaining formats share the standard parser. Standard
    # handles native IEEE input ("G. Liu, K. Y. Lee") correctly AND pairs
    # "Last, Initials" when a reference is mis-classified as IEEE.
    return _parse_standard_authors(author_text)


def _parse_vancouver_authors(text: str) -> list[str]:
    """Parse Vancouver-style: 'Shingjergji K, Iren D, Urlings C, Klemke R'

    No comma between last name and initials. No period after initials.
    """
    # Remove trailing "et al." or "et al"
    text = re.sub(r",?\s*et\s+al\.?\s*$", "", text, flags=re.IGNORECASE).strip()

    # Split by comma — each part is "LastName Initials"
    parts = [p.strip() for p in text.split(",") if p.strip()]
    authors = []
    for part in parts:
        part = part.strip().rstrip(".")
        if len(part) > 1:
            authors.append(part)
    return authors[:20]


def _parse_standard_authors(author_text: str) -> list[str]:
    """Parse standard author format (APA/MLA/Chicago/Harvard).

    Handles: "Author, A., Author, B., & Author, C."
             "Author, Alice, and Bob Author"
    """
    if not author_text:
        return []

    # Normalize conjunctions to commas
    author_text = normalize_author_conjunctions(author_text)

    # Remove "et al." and Turkish "vd" / "vd." / "diğerleri" (= "et al.")
    author_text = re.sub(r",?\s*et\s+al\.?\s*$", "", author_text, flags=re.IGNORECASE).strip()
    author_text = re.sub(r",?\s*vd\.?\s*$", "", author_text, flags=re.IGNORECASE).strip()
    author_text = re.sub(r",?\s*diğerleri\s*$", "", author_text, flags=re.IGNORECASE).strip()

    # Split by comma
    parts = [p.strip() for p in author_text.split(",") if p.strip()]

    # Reassemble "Last, Initials" or "Last, First" pairs
    # Kurallar Rule 12: ", K." = author; Rule 7: single letter + period = abbreviation
    authors = []
    # Recognize a complete "Surname Initial(s)" Vancouver-style entry so
    # we don't over-pair (e.g. "Savran A." shouldn't grab "Sankur B").
    complete_vanc_re = re.compile(
        r"^[A-ZÇĞİÖŞÜ][a-zçğıöşü]+(?:[-\s][A-ZÇĞİÖŞÜ][a-zçğıöşü]+)*"
        r"\s+[A-ZÇĞİÖŞÜ](?:\.?[A-ZÇĞİÖŞÜ]){0,3}\.?$"
    )
    i = 0
    while i < len(parts):
        part = parts[i]
        # If part is already "Surname Init" (Vancouver-complete), don't pair.
        if complete_vanc_re.match(part):
            authors.append(part)
            i += 1
            continue
        if i + 1 < len(parts):
            next_part = parts[i + 1].strip()
            # Check if next part is initials. Handles:
            #   - plain / multi:     "A.", "A. S.", "C. J. C. H."
            #   - hyphenated upper:  "R.-N.", "C.-Y."
            #   - compound given:    "A.-r." (Abdel-rahman), "A. u." (Aziz ul)
            #   - interleaved upper/lower: "C. d. S." (Brazilian), "J. P. d. S."
            is_initials = bool(re.match(
                r"^[A-ZÇĞİÖŞÜ]"
                r"(?:[.\-\s]+(?:[A-ZÇĞİÖŞÜ]|[a-zçğıöşü]+))*"
                r"\.?$",
                next_part,
            ))
            # Check if next part is a given-name section:
            #   - plain first name: "John", "Alice"
            #   - hyphenated given with uppercase: "Ying-Chun", "Bao-Liang"
            #   - first name + middle initial: "Julian P.", "Buse N."
            #   - multi-word given: "Buse Nur"
            is_first_name = bool(re.match(
                r"^[A-ZÇĞİÖŞÜ][a-zçğıöşü]*(?:-[A-ZÇĞİÖŞÜa-zçğıöşü]+)?"
                r"(?:\s+[A-ZÇĞİÖŞÜ][a-zçğıöşü]*(?:-[A-ZÇĞİÖŞÜa-zçğıöşü]+)?)?\.?$",
                next_part,
            ))
            if is_initials or is_first_name:
                authors.append(f"{part}, {next_part}")
                i += 2
                continue
        if len(part) > 1:  # Skip lone single-char initials (keep 2-char surnames like "Fu", "Li")
            authors.append(part)
        i += 1

    return authors[:20]


# ---------------------------------------------------------------------------
# Parse confidence scoring
# ---------------------------------------------------------------------------

def _compute_parse_confidence(parsed: ParsedSource) -> float:
    """Compute confidence score for parsed fields.

    Higher confidence means we trust the structured fields more.
    Low confidence triggers raw-text fallback in verification.
    """
    score = 0.0

    # DOI is the strongest signal
    if parsed.doi:
        score += 0.40

    # Authors with meaningful names
    valid_authors = [a for a in parsed.authors if len(a.strip()) >= 2]
    if valid_authors:
        score += 0.20

    # Year in valid range
    if parsed.year and 1900 <= parsed.year <= 2030:
        score += 0.15

    # Title of reasonable length
    if len(parsed.title) >= 10:
        score += 0.15

    # Source (journal/conference/publisher) present
    if parsed.source and len(parsed.source) >= 3:
        score += 0.10

    return min(round(score, 2), 1.0)
