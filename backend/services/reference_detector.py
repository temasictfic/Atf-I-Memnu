"""Detect reference/source sections in parsed PDF documents and extract individual references."""

import re

from models.pdf_document import PdfDocument, TextBlock
from models.source import SourceRectangle, BoundingBox

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
    r"^\s*(\d{1,3})-\s*",       # 1- Text...
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


def detect_references(document: PdfDocument) -> list[SourceRectangle]:
    """Detect reference section and extract individual source rectangles."""
    all_blocks = []
    for page in document.pages:
        merged = _merge_line_fragments(page.text_blocks)
        for block in merged:
            all_blocks.append((page.page_num, block))

    # Find the reference section header
    ref_start_idx = _find_reference_header(all_blocks)
    if ref_start_idx is None:
        return []

    # Get all blocks after the header
    ref_blocks = all_blocks[ref_start_idx + 1:]
    if not ref_blocks:
        return []

    # Filter out non-reference blocks (instruction text, footers, page numbers)
    ref_blocks = _filter_reference_blocks(ref_blocks)

    # Try numbered references first
    sources = _split_numbered_references(ref_blocks, document.id)

    # Validate numbered results — reject if numbers are unreasonable
    if sources and not _validate_numbered_sources(sources):
        sources = []

    # Try unnumbered (APA-style) and use whichever gives more results
    unnumbered = _split_unnumbered_references(ref_blocks, document.id)
    if len(unnumbered) > len(sources):
        sources = unnumbered

    return sources


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
        # Skip very short text that's just a number (page numbers)
        if len(text) < 5 and text.isdigit():
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
    """Split blocks into individual numbered references like [1], 1., 1)."""
    sources: list[SourceRectangle] = []
    current_ref_text = ""
    current_ref_num = None
    current_ref_blocks: list[tuple[int, TextBlock]] = []

    for page_num, block in blocks:
        text = block.text.strip()
        if not text:
            continue

        ref_num = _extract_ref_number(text)
        if ref_num is not None:
            # Save previous reference
            if current_ref_blocks:
                source = _create_source_rectangle(
                    current_ref_blocks, current_ref_text, current_ref_num, pdf_id
                )
                if source:
                    sources.append(source)

            current_ref_text = text
            current_ref_num = ref_num
            current_ref_blocks = [(page_num, block)]
        elif current_ref_blocks:
            # Continuation of current reference
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

        is_new_ref = _is_unnumbered_ref_start(text, current_ref_blocks, page_num, block)

        if is_new_ref:
            # Save previous reference
            if current_ref_blocks and _looks_like_reference(current_ref_text):
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
                if _looks_like_reference(current_ref_text):
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
    if current_ref_blocks and _looks_like_reference(current_ref_text):
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
    """Check if a line starts a new unnumbered reference."""
    if not text or len(text) < 15:
        return False

    # Must start with uppercase letter, quote, or opening paren
    first = text[0]
    if not (first.isupper() or first in '"(\u201C'):
        return False

    # Check for author-like pattern at start
    author_patterns = [
        r"^[A-ZÀ-Ž\u00C0-\u024F][a-zà-ž\u00C0-\u024F]+,\s",        # LastName, ...
        r"^[A-ZÀ-Ž\u00C0-\u024F][a-zà-ž\u00C0-\u024F]+\s+[A-Z]",   # Lastname I
        r"^[A-ZÀ-Ž\u00C0-\u024F][a-zà-ž\u00C0-\u024F]+\s+&",       # Lastname &
        r'^[A-Z]{2,},\s',                                              # ORG, ...
        r'^[A-Z]{2,}\.\s',                                             # ORG. ...
        r'^[A-Z]{2,}\s+\d{4}',                                         # ORG 2004
        r'^[A-Z]{2,}\s+\(',                                            # ORG (
        r'^"[A-Z]',                                                     # "Title
        r'^\u201C',                                                     # "Title (curly quote)
        r'^\(\d{4}\)',                                                  # (2004) ...
        r'^\([A-Z\u00C0-\u024F][a-z\u00C0-\u024F]+',                     # (Author...
    ]

    if not any(re.match(p, text) for p in author_patterns):
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
    # Should contain a year (4-digit number between 1900-2099)
    if not re.search(r"(?:19|20)\d{2}", text):
        return False
    return True


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
