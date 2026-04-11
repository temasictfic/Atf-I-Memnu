"""Detect reference/source sections in parsed PDF documents and extract individual references."""

import logging
import re

from models.pdf_document import PdfDocument, TextBlock
from models.source import SourceRectangle, BoundingBox

logger = logging.getLogger(__name__)

# Patterns for reference section headers — KAYNAKLAR-specific (Turkish)
# These must match the whole line as a header, not text that happens to contain these words.
HEADER_PATTERNS_STRICT = [
    r"(?i)^\s*(EK[-\s]?\d*\s*[A-Z]?[:.\s]*)?\s*(KAYNAKLAR|KAYNAK[CÇ]A)\s*$",
    r"(?i)^\s*(REFERENCES?|BIBLIOGRAPHY|WORKS?\s+CITED)\s*$",
    r"(?i)^\s*LITERAT[UÜ]R\s*$",
]

# Looser patterns for short lines (< 40 chars) that might have trailing punctuation
HEADER_PATTERNS_LOOSE = [
    r"(?i)(EK[-\s]?\d*\s*[A-Z]?[:.\s]*)?\s*(KAYNAKLAR|KAYNAK[CÇ]A)",
    r"(?i)^(REFERENCES?|BIBLIOGRAPHY)\s*[:.]*\s*$",
]

# Patterns for individual reference numbers
REF_NUMBER_PATTERNS = [
    r"^\s*\[(\d{1,3})\]\s*",    # [1] Text...
    r"^\s*(\d{1,3})\.\s+",      # 1. Text...
    r"^\s*(\d{1,3})\)\s+",      # 1) Text...
    r"^\s*(\d{1,3})-(?!\d)\s*",  # 1- Text... (but not 014-1315-y)
]

# Instruction text patterns — blocks matching these are skipped entirely
INSTRUCTION_PATTERNS = [
    r"^\d{4}BF[-\s]?\d+",
    r"(?i)^bu\s+b[oö]l[uü]mde",
    r"(?i)^proje\s+[oö]nerisinde",
    r"(?i)sayfas[ıi]ndaki\s+a[cç][ıi]klamalara",
    r"(?i)verilmeli\s+ve\s+bu\s+kaynaklara",
    r"(?i)sonuna\s+DOI\s+numaras[ıi]",
    r"(?i)i[cç]erisinde\s+(ilgili\s+yerlerde|at[ıi]f)",
    r"(?i)^g[uü]ncelleme\s+tarihi",
    r"(?i)^zorunludur\s*[.\s]*$",
    r"(?i)yap[ıi]lmal[ıi]d[ıi]r",
    r"(?i)kaynaklar[ıi]n\s+listesi",
    r"(?i)bibliyografik",
    r"(?i)verilerin.duzenlenmesi",
    r"(?i)eklenmesi\s*$",
    r"(?i)Kurum\sİçi\sSınırsız\sKullanım\s/\sKişisel\sVeri\sDeğil",
    r"(?i)^\s*\d{4}\s*[-–—]{1,2}\s*BF\s+G[uü]ncelleme\s+Tarihi\s*:\s*\d{2}/\d{2}/\d{4}\s*$",
]


def _merge_line_fragments(blocks: list[TextBlock]) -> list[TextBlock]:
    """Merge word-level fragments that belong to the same text line.

    Some PDFs produce one TextBlock per word/span instead of per line.
    We merge blocks whose vertical centers overlap and are horizontally adjacent.
    """
    if not blocks:
        return blocks

    # Sort by y-center then x0
    sorted_blocks = sorted(blocks, key=lambda b: (b.bbox[1] + b.bbox[3], b.bbox[0]))

    merged: list[TextBlock] = []
    current = sorted_blocks[0]

    for block in sorted_blocks[1:]:
        cur_y_mid = (current.bbox[1] + current.bbox[3]) / 2
        blk_y_mid = (block.bbox[1] + block.bbox[3]) / 2
        cur_height = current.bbox[3] - current.bbox[1]
        blk_height = block.bbox[3] - block.bbox[1]
        line_height = max(cur_height, blk_height, 5)

        # Same line: vertical centers within half a line-height
        same_line = abs(cur_y_mid - blk_y_mid) < line_height * 0.6
        # Horizontal gap: block starts within 3x line-height of current end
        h_gap = block.bbox[0] - current.bbox[2]
        close_h = h_gap < line_height * 3

        if same_line and close_h:
            # Merge: expand bbox, concatenate text
            sep = "" if current.text.endswith("-") else " "
            current = TextBlock(
                text=current.text + sep + block.text,
                bbox=[
                    min(current.bbox[0], block.bbox[0]),
                    min(current.bbox[1], block.bbox[1]),
                    max(current.bbox[2], block.bbox[2]),
                    max(current.bbox[3], block.bbox[3]),
                ],
                page=current.page,
                font_size=max(current.font_size, block.font_size),
                font_name=current.font_name,
                is_bold=current.is_bold or block.is_bold,
            )
        else:
            merged.append(current)
            current = block

    merged.append(current)
    return merged


def detect_references(document: PdfDocument) -> tuple[list[SourceRectangle], bool]:
    """Detect reference section and extract individual source rectangles.

    Returns:
        (sources, numbered) — list of detected references and whether they are numbered.
    """
    all_blocks = []
    for page in document.pages:
        merged = _merge_line_fragments(page.text_blocks)
        for block in merged:
            all_blocks.append((page.page_num, block))

    # Find the reference section header
    ref_start_idx = _find_reference_header(all_blocks)
    if ref_start_idx is None:
        return [], False

    # Get all blocks after the header
    ref_blocks = all_blocks[ref_start_idx + 1:]
    if not ref_blocks:
        return [], False

    # Filter out non-reference blocks (instruction text, footers, page numbers)
    ref_blocks = _filter_reference_blocks(ref_blocks)

    # Try numbered references first — regex is reliable for numbered refs
    sources = _split_numbered_references(ref_blocks, document.id)

    # Validate numbered results — reject if numbers are unreasonable
    if sources and not _validate_numbered_sources(sources):
        sources = []

    # If numbered detection succeeded, use it directly
    if sources:
        logger.info("Numbered detection found %d refs for %s", len(sources), document.id)
        return sources, True

    # Unnumbered: try empty-line gap detection first, fall back to APA-heuristic
    gap_sources = _split_by_empty_lines(ref_blocks, document.id)
    if gap_sources:
        logger.info("Empty-line gap detection found %d refs for %s", len(gap_sources), document.id)
        return gap_sources, False

    logger.info("No empty-line gaps — falling back to APA heuristic for %s", document.id)
    return _split_unnumbered_references(ref_blocks, document.id), False



def _find_reference_header(blocks: list[tuple[int, TextBlock]]) -> int | None:
    """Find the index of the reference section header block.

    Strategy: find ALL candidate headers, prefer the one that's followed by
    actual reference content (not instruction text).
    """
    candidates = []
    for idx, (page_num, block) in enumerate(blocks):
        text = block.text.strip()

        # Strict match: exact header line
        if any(re.match(p, text) for p in HEADER_PATTERNS_STRICT):
            candidates.append(idx)
            continue

        # Loose match: short line with header keywords
        if len(text) < 50:
            if block.is_bold and any(re.search(p, text) for p in HEADER_PATTERNS_LOOSE):
                candidates.append(idx)
                continue
            if any(re.search(p, text) for p in HEADER_PATTERNS_LOOSE):
                candidates.append(idx)
                continue

    if not candidates:
        return None

    # If only one candidate, use it
    if len(candidates) == 1:
        return candidates[0]

    # Multiple candidates: pick the one with the best content after it
    # Prefer candidates where blocks after it look like references (not instruction text)
    for candidate_idx in candidates:
        blocks_after = blocks[candidate_idx + 1: candidate_idx + 10]
        non_instruction_count = 0
        for _, b in blocks_after:
            t = b.text.strip()
            if not t or len(t) < 5:
                continue
            if _is_instruction_text(t):
                continue
            non_instruction_count += 1

        if non_instruction_count >= 3:
            return candidate_idx

    # Fallback: use the first candidate
    return candidates[0]


def _is_instruction_text(text: str) -> bool:
    """Check if text is instruction/form text that should be skipped."""
    return any(re.search(p, text) for p in INSTRUCTION_PATTERNS)


def _filter_reference_blocks(blocks: list[tuple[int, TextBlock]]) -> list[tuple[int, TextBlock]]:
    """Filter out non-reference content like instruction text, footers, page numbers."""
    filtered = []
    for page_num, block in blocks:
        text = block.text.strip()
        if not text:
            continue
        # Skip page numbers: 1-3 digit numbers that likely sit alone as a footer.
        # Don't filter 4+ digit numbers — those are typically article/page IDs that
        # legitimately appear at the end of a citation (e.g., "Mathematics 12(24), 3892").
        if text.isdigit() and len(text) <= 3:
            continue
        # Skip known non-reference patterns
        if _is_instruction_text(text):
            continue
        # Skip lines that are just tubitak URLs (instruction context)
        if "tubitak.gov.tr" in text.lower() and not _has_ref_number(text):
            continue
        filtered.append((page_num, block))
    return filtered


def _validate_numbered_sources(sources: list[SourceRectangle]) -> bool:
    """Validate that numbered references look reasonable.

    Reject if: first number is too high (> 10), or numbers don't roughly
    ascend (likely false positives from page numbers, DOI, etc.)
    """
    if not sources:
        return False
    nums = [s.ref_number for s in sources if s.ref_number is not None]
    if not nums:
        return False
    # First ref number should be small (1-10 typically)
    if nums[0] > 10:
        return False
    # Should have some ascending tendency
    ascending = sum(1 for i in range(1, len(nums)) if nums[i] > nums[i - 1])
    if len(nums) > 2 and ascending < len(nums) // 3:
        return False
    return True


def _has_ref_number(text: str) -> bool:
    return any(re.match(p, text) for p in REF_NUMBER_PATTERNS)


def _split_numbered_references(
    blocks: list[tuple[int, TextBlock]],
    pdf_id: str,
) -> list[SourceRectangle]:
    """Split blocks into individual numbered references like [1], 1., 1).

    Requires sequential numbering: a candidate is accepted as a new reference
    only if its number is the next expected value (current + 1), or close to it
    (allowing small gaps for editorial errors).  This prevents false matches
    on URLs/DOIs/page numbers that contain digit patterns.
    """
    sources: list[SourceRectangle] = []
    current_ref_text = ""
    current_ref_num: int | None = None
    current_ref_blocks: list[tuple[int, TextBlock]] = []

    def _is_valid_next(candidate: int) -> bool:
        if current_ref_num is None:
            # First reference: accept small starting numbers (typically 1)
            return candidate <= 3
        # Subsequent reference: must be exactly next or close (editorial gaps)
        return current_ref_num < candidate <= current_ref_num + 2

    for page_num, block in blocks:
        text = block.text.strip()
        if not text:
            continue

        candidate = _extract_ref_number(text)
        is_new_ref = candidate is not None and _is_valid_next(candidate)

        if is_new_ref:
            # Save previous reference
            if current_ref_blocks:
                source = _create_source_rectangle(
                    current_ref_blocks, current_ref_text, current_ref_num, pdf_id
                )
                if source:
                    sources.append(source)

            current_ref_text = text
            current_ref_num = candidate
            current_ref_blocks = [(page_num, block)]
        elif current_ref_blocks:
            # Continuation of current reference (even if it starts with a number
            # like "12." inside a URL — sequential check rejected it as a new ref)
            if _is_continuation(current_ref_blocks, page_num, block):
                current_ref_text += " " + text
                current_ref_blocks.append((page_num, block))

    # Last reference
    if current_ref_blocks:
        source = _create_source_rectangle(
            current_ref_blocks, current_ref_text, current_ref_num, pdf_id
        )
        if source:
            sources.append(source)

    return sources


def _split_by_empty_lines(
    blocks: list[tuple[int, TextBlock]],
    pdf_id: str,
) -> list[SourceRectangle]:
    """Split blocks into references using empty-line gaps + hanging indents.

    Three boundary signals (any one triggers a new reference):
      1. Same-page: vertical gap > line_height (= empty line / extra spacing)
      2. Same-page: hanging indent (current line flush-left, previous indented)
      3. Page break: first block on new page is flush-left or starts with
         an author-like pattern

    Uses minimum gap (= normal line spacing) as the baseline rather than median,
    so PDFs with uniform spacing still split correctly when blank lines exist.

    Returns an empty list if too few boundaries are detected (caller falls back).
    """
    if len(blocks) < 2:
        return []

    # --- Step 1: compute baseline line spacing per page ---
    # Collect consecutive same-page gaps
    gaps_per_page: dict[int, list[float]] = {}
    for i in range(1, len(blocks)):
        prev_page, prev_block = blocks[i - 1]
        curr_page, curr_block = blocks[i]
        if curr_page != prev_page:
            continue
        gap = curr_block.bbox[1] - prev_block.bbox[3]
        if gap >= -2:  # allow tiny negative for rendering quirks
            gaps_per_page.setdefault(curr_page, []).append(max(gap, 0))

    if not gaps_per_page:
        return []

    # Baseline = minimum gap on each page (= normal within-paragraph line spacing)
    baseline_gap: dict[int, float] = {}
    line_height_per_page: dict[int, float] = {}
    for page, page_gaps in gaps_per_page.items():
        baseline_gap[page] = min(page_gaps) if page_gaps else 0

    # Average line height per page from block heights
    line_heights: dict[int, list[float]] = {}
    for page_num, block in blocks:
        h = block.bbox[3] - block.bbox[1]
        if h > 0:
            line_heights.setdefault(page_num, []).append(h)
    for page, heights in line_heights.items():
        line_height_per_page[page] = sum(heights) / len(heights)

    # --- Step 2: detect hanging-indent edge (APA flush-left x0) ---
    # Find the smallest x0 per page; first lines of refs sit at this edge.
    min_x0_per_page: dict[int, float] = {}
    for page_num, block in blocks:
        x0 = block.bbox[0]
        if page_num not in min_x0_per_page or x0 < min_x0_per_page[page_num]:
            min_x0_per_page[page_num] = x0

    # --- Step 3: find boundary positions ---
    boundary_indices: list[int] = [0]  # first block always starts a ref

    for i in range(1, len(blocks)):
        prev_page, prev_block = blocks[i - 1]
        curr_page, curr_block = blocks[i]
        text = curr_block.text.strip()

        if curr_page != prev_page:
            # Page break: check flush-left position or author-like start
            page_min_x0 = min_x0_per_page.get(curr_page, 0)
            is_flush_left = curr_block.bbox[0] <= page_min_x0 + 2.0
            looks_like_author = bool(text) and _starts_with_author_pattern(text)

            if (is_flush_left or looks_like_author) and len(text) >= 15:
                boundary_indices.append(i)
            continue

        # Same-page boundary detection
        gap = curr_block.bbox[1] - prev_block.bbox[3]
        baseline = baseline_gap.get(curr_page, 0)
        lh = line_height_per_page.get(curr_page, 12)

        # Empty-line gap: gap must be notably larger than the baseline.
        # Use both an absolute threshold (baseline + 0.4× line height) and a
        # relative one (3× baseline) so tight-spaced PDFs with small baselines
        # also trigger correctly.
        gap_is_blank_line = gap > max(baseline + lh * 0.4, baseline * 3 + 1)

        # Hanging indent: current line flush-left, previous line indented
        page_min_x0 = min_x0_per_page.get(curr_page, 0)
        curr_is_flush_left = curr_block.bbox[0] <= page_min_x0 + 2.0
        prev_is_indented = prev_block.bbox[0] > page_min_x0 + 3.0
        indent_boundary = curr_is_flush_left and prev_is_indented and len(text) >= 15

        # Author-pattern boundary: current line clearly starts a new ref.
        # The strict author pattern is a strong enough signal on its own —
        # this catches tight-spaced PDFs with no empty-line gaps, including
        # references that end with URLs (no terminal period).
        # However, if the previous line ends with a continuation marker
        # (comma, "&", "ve", "and"), the author list is wrapping — not a new ref.
        prev_text = prev_block.text.strip().rstrip()
        prev_continues_authors = bool(re.search(
            r"(?:[,;&]|\bve|\band|\beds?\.)\s*$", prev_text, re.IGNORECASE
        ))
        author_boundary = (
            len(text) >= 15
            and not prev_continues_authors
            and _starts_with_author_pattern(text)
            and not _looks_like_continuation(text)
        )

        if gap_is_blank_line or indent_boundary or author_boundary:
            boundary_indices.append(i)

    # Need enough boundaries to be confident
    if len(boundary_indices) < 4:
        return []

    # --- Step 3: group blocks into references ---
    sources: list[SourceRectangle] = []
    ref_counter = 0

    for b in range(len(boundary_indices)):
        start_idx = boundary_indices[b]
        end_idx = boundary_indices[b + 1] if b + 1 < len(boundary_indices) else len(blocks)

        ref_blocks = blocks[start_idx:end_idx]
        ref_text = " ".join(blk.text.strip() for _, blk in ref_blocks if blk.text.strip())

        if not ref_text or len(ref_text) < 20:
            continue

        # Validation: should look like a citation (year, DOI, et al., or quoted title)
        if not _looks_like_citation(ref_text):
            continue

        ref_counter += 1
        source = _create_source_rectangle(ref_blocks, ref_text, ref_counter, pdf_id)
        if source:
            sources.append(source)

    logger.info(
        "Empty-line split: %d gaps above threshold, %d valid refs from %d blocks",
        len(boundary_indices) - 1, len(sources), len(blocks),
    )
    return sources


# Stricter author start patterns that require initials/first-name after the
# last name to avoid false matches on things like "Information Sciences, 191".
_AUTHOR_START_PATTERNS = [
    # LastName, A. or LastName, A.B. (initials with periods)
    re.compile(r"^[A-ZÀ-Ž\u00C0-\u024F][\wà-ž\u00C0-\u024F'’\-]+,\s+[A-Z]\."),
    # LastName, FirstName  (multi-letter first name)
    re.compile(r"^[A-ZÀ-Ž\u00C0-\u024F][\wà-ž\u00C0-\u024F'’\-]+,\s+[A-Z][a-zà-ž\u00C0-\u024F]"),
    # LastName A.  (Vancouver: no comma, initials with period)
    re.compile(r"^[A-ZÀ-Ž\u00C0-\u024F][a-zà-ž\u00C0-\u024F]+\s+[A-Z]\."),
    # LastName & (& joining authors)
    re.compile(r"^[A-ZÀ-Ž\u00C0-\u024F][a-zà-ž\u00C0-\u024F]+\s+&"),
    # All-caps organization followed by year, opening paren, or period
    re.compile(r"^[A-Z]{2,},?\s+(?:\d{4}|\(|[A-Z][a-z])"),
    # Quoted title at the start of a citation
    re.compile(r'^"[A-Z]'),
    re.compile(r"^\u201C[A-Z]"),
    # Last name without comma followed by year in parens: "Smith (2020)"
    re.compile(r"^[A-ZÀ-Ž\u00C0-\u024F][a-zà-ž\u00C0-\u024F]+\s+\(\d{4}"),
    # Title-only citations followed by a URL: "Tufts Face Database. https://..."
    re.compile(r"^[A-Z][\w'’\-]+(?:\s+[A-Z][\w'’\-]+){1,5}\.\s+https?://"),
]


# Patterns that indicate a line is a CONTINUATION (not a new ref start)
# even though it might match an author pattern
_CONTINUATION_PATTERNS = [
    # "(YEAR). Title..." — year+title line follows an author-list line
    re.compile(r"^\(\d{4}[a-z]?\)\.?\s"),
    # Lines that start with a closing-quote or page-range pattern
    re.compile(r"^\d+(?:[\-–—]\d+)?\."),
]


def _looks_like_continuation(text: str) -> bool:
    return any(p.match(text) for p in _CONTINUATION_PATTERNS)


# Patterns that signal text is a citation (any one is sufficient)
_CITATION_SIGNAL_PATTERNS = [
    re.compile(r"(?:19|20)\d{2}"),                  # year 1900-2099
    re.compile(r"\bet\s+al\b", re.IGNORECASE),      # "et al."
    re.compile(r"\b10\.\d{4,9}/"),                  # DOI prefix
    re.compile(r"https?://"),                       # URL
    re.compile(r'"[^"]{10,}"'),                     # quoted title (>10 chars)
    re.compile(r"\u201C[^\u201D]{10,}\u201D"),     # smart-quoted title
    re.compile(r"\bpp\.\s*\d"),                     # "pp. 123"
    re.compile(r"\bvol\.\s*\d", re.IGNORECASE),     # "vol. 5"
]


def _looks_like_citation(text: str) -> bool:
    """Check if text contains at least one signal indicating it's a citation."""
    return any(p.search(text) for p in _CITATION_SIGNAL_PATTERNS)


def _starts_with_author_pattern(text: str) -> bool:
    """Check if text starts with a recognizable author/citation pattern."""
    return any(p.match(text) for p in _AUTHOR_START_PATTERNS)


def _split_unnumbered_references(
    blocks: list[tuple[int, TextBlock]],
    pdf_id: str,
) -> list[SourceRectangle]:
    """Split blocks into individual unnumbered references (APA-style).

    A new reference starts when a line begins with an author name pattern:
    - Capitalized word followed by comma (LastName, ...)
    - All-caps abbreviation like AOAC, IEEE, etc.
    - Capitalized word that looks like a name, not a continuation word
    """
    sources: list[SourceRectangle] = []
    current_ref_text = ""
    current_ref_blocks: list[tuple[int, TextBlock]] = []
    ref_counter = 0

    for page_num, block in blocks:
        text = block.text.strip()
        if not text:
            continue

        # Very short fragments (single words) are always continuations
        if len(text) < 10 and current_ref_blocks:
            if _is_continuation(current_ref_blocks, page_num, block):
                current_ref_text += " " + text
                current_ref_blocks.append((page_num, block))
                continue

        # Lines like "(2017). Title..." are continuations of an author list above,
        # not new references — even though they look citation-like.
        if _looks_like_continuation(text) and current_ref_blocks:
            if _is_continuation(current_ref_blocks, page_num, block):
                current_ref_text += " " + text
                current_ref_blocks.append((page_num, block))
                continue

        is_new_ref = _is_unnumbered_ref_start(text, current_ref_blocks, page_num, block)

        if is_new_ref:
            # Save previous reference (don't drop it even if no year — the
            # year may be in the new ref's first block which we're now starting)
            if current_ref_blocks:
                ref_counter += 1
                source = _create_source_rectangle(
                    current_ref_blocks, current_ref_text, ref_counter, pdf_id
                )
                if source:
                    sources.append(source)

            current_ref_text = text
            current_ref_blocks = [(page_num, block)]
        elif current_ref_blocks:
            # Continuation
            if _is_continuation(current_ref_blocks, page_num, block):
                current_ref_text += " " + text
                current_ref_blocks.append((page_num, block))
            else:
                # Too far apart — save current and start new
                ref_counter += 1
                source = _create_source_rectangle(
                    current_ref_blocks, current_ref_text, ref_counter, pdf_id
                )
                if source:
                    sources.append(source)
                current_ref_text = text
                current_ref_blocks = [(page_num, block)]
        else:
            # First block — start accumulating
            current_ref_text = text
            current_ref_blocks = [(page_num, block)]

    # Last reference
    if current_ref_blocks:
        ref_counter += 1
        source = _create_source_rectangle(
            current_ref_blocks, current_ref_text, ref_counter, pdf_id
        )
        if source:
            sources.append(source)

    return sources


def _is_unnumbered_ref_start(
    text: str,
    current_blocks: list[tuple[int, TextBlock]],
    page_num: int,
    block: TextBlock,
) -> bool:
    """Check if a line starts a new unnumbered reference.

    Detects two signals:
    1. Text starts with an author-like pattern (LastName, / ORG / etc.)
    2. APA hanging indent: this line is flush-left while previous continuation
       lines were indented (first line sticks out to the left).
    """
    if not text or len(text) < 15:
        return False

    # --- Hanging indent detection (APA format) ---
    # If we have previous blocks, check if this line is further left
    # (= flush-left first line) while previous lines were indented.
    if current_blocks:
        last_page, last_block = current_blocks[-1]
        if page_num == last_page:
            indent_diff = last_block.bbox[0] - block.bbox[0]
            # Current line is at least a few pixels further left than previous
            # → likely a new reference's first line (hanging indent)
            if indent_diff > 3.0:
                return True

    # Must start with uppercase letter, quote, or opening paren
    first = text[0]
    if not (first.isupper() or first in '"(\u201C'):
        return False

    # Use the strict author pattern set (requires initials/first-name after comma)
    if not _starts_with_author_pattern(text):
        return False

    # If we have no current blocks, this is the first reference
    if not current_blocks:
        return True

    return True


def _is_continuation(
    current_blocks: list[tuple[int, TextBlock]],
    page_num: int,
    block: TextBlock,
) -> bool:
    """Check if a block is a continuation of the current reference."""
    if not current_blocks:
        return False

    last_page, last_block = current_blocks[-1]

    if page_num == last_page:
        # Same page: check vertical proximity
        last_y1 = last_block.bbox[3]
        curr_y0 = block.bbox[1]
        line_height = max(last_block.bbox[3] - last_block.bbox[1], 10)
        return curr_y0 - last_y1 < line_height * 5.0
    elif page_num == last_page + 1:
        # Next page: references can span pages
        return True

    return False


def _looks_like_reference(text: str) -> bool:
    """Check if accumulated text looks like an actual academic reference."""
    if not text or len(text) < 20:
        return False
    return _looks_like_citation(text)


def _extract_ref_number(text: str) -> int | None:
    """Extract the reference number from the start of a text block."""
    for pattern in REF_NUMBER_PATTERNS:
        match = re.match(pattern, text)
        if match:
            try:
                return int(match.group(1))
            except (ValueError, IndexError):
                continue
    return None


def _create_source_rectangle(
    blocks: list[tuple[int, TextBlock]],
    text: str,
    ref_num: int | None,
    pdf_id: str,
) -> SourceRectangle | None:
    """Create a SourceRectangle from a list of text blocks forming one reference."""
    if not blocks or not text.strip():
        return None

    # Group blocks by page
    pages_blocks: dict[int, list[TextBlock]] = {}
    for page_num, block in blocks:
        pages_blocks.setdefault(page_num, []).append(block)

    padding = 3.0
    bboxes: list[BoundingBox] = []

    for page_num in sorted(pages_blocks.keys()):
        page_blocks = pages_blocks[page_num]
        x0 = max(0, min(b.bbox[0] for b in page_blocks) - padding)
        y0 = max(0, min(b.bbox[1] for b in page_blocks) - padding)
        x1 = max(b.bbox[2] for b in page_blocks) + padding
        y1 = max(b.bbox[3] for b in page_blocks) + padding
        bboxes.append(BoundingBox(x0=x0, y0=y0, x1=x1, y1=y1, page=page_num))

    return SourceRectangle(
        id=f"{pdf_id}_ref_{ref_num}",
        pdf_id=pdf_id,
        bbox=bboxes[0],
        bboxes=bboxes if len(bboxes) > 1 else [],
        text=text.strip(),
        ref_number=ref_num,
        status="detected",
    )
