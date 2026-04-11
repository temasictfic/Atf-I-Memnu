"""NER-assisted reference boundary detection for unnumbered references.

Uses the SIRIS-Lab citation parser to detect AUTHORS entities, then
identifies reference boundaries where new author spans begin after a gap.
This is a third detection strategy alongside numbered and APA-heuristic.
"""

import asyncio
import logging
import re
from collections import defaultdict

from models.pdf_document import TextBlock
from models.source import SourceRectangle, BoundingBox

logger = logging.getLogger(__name__)

# Minimum confidence for accepting an AUTHORS entity
_MIN_AUTHOR_SCORE = 0.4

# Maximum window size (characters) for NER inference.
# SIRIS/DistilBERT has a 512-token limit; ~1500 chars is safe.
_WINDOW_SIZE = 1400
_WINDOW_OVERLAP = 300


def detect_boundaries_ner_sync(
    blocks: list[tuple[int, TextBlock]],
    pdf_id: str,
    pipeline,
) -> list[SourceRectangle]:
    """Split reference blocks into individual references using NER author detection.

    Args:
        blocks: filtered reference section blocks as (page_num, TextBlock) tuples
        pdf_id: PDF identifier for SourceRectangle IDs
        pipeline: loaded SIRIS NER pipeline (transformers)

    Returns:
        List of SourceRectangle objects, one per detected reference.
    """
    if not blocks or pipeline is None:
        return []

    # Build a mapping from character offset to (block_index, page_num, block)
    concat_text, block_spans = _concatenate_blocks(blocks)
    if not concat_text.strip():
        return []

    logger.info("NER boundary: processing %d chars across %d blocks", len(concat_text), len(blocks))

    # Run NER on sliding windows to find AUTHORS entities
    author_spans = _find_author_spans(pipeline, concat_text)
    logger.info("NER boundary: found %d author spans", len(author_spans))
    if not author_spans:
        return []

    # Identify boundary positions: where a new AUTHORS span starts
    # after a gap (= new reference)
    boundaries = _detect_boundaries(author_spans, concat_text)
    logger.info("NER boundary: detected %d boundaries", len(boundaries))

    # Split concatenated text at boundaries back into individual references
    sources = _split_at_boundaries(
        boundaries, concat_text, block_spans, blocks, pdf_id
    )
    logger.info("NER boundary: produced %d source rectangles", len(sources))

    return sources


def _concatenate_blocks(
    blocks: list[tuple[int, TextBlock]],
) -> tuple[str, list[tuple[int, int, int]]]:
    """Concatenate block texts with space separators.

    Returns:
        (concatenated_text, block_spans) where block_spans[i] = (char_start, char_end, block_index)
    """
    parts = []
    spans = []  # (char_start, char_end, block_index)
    offset = 0

    for i, (page_num, block) in enumerate(blocks):
        text = block.text.strip()
        if not text:
            continue
        if offset > 0:
            parts.append(" ")
            offset += 1
        start = offset
        parts.append(text)
        offset += len(text)
        spans.append((start, offset, i))

    return "".join(parts), spans


def _find_author_spans(
    pipeline, text: str
) -> list[dict]:
    """Run NER on sliding windows and collect AUTHORS entity spans.

    Returns list of dicts with keys: start, end, score (in concat_text coordinates).
    """
    author_spans = []

    # Process text in overlapping windows
    pos = 0
    while pos < len(text):
        window_end = min(pos + _WINDOW_SIZE, len(text))
        window_text = text[pos:window_end]

        try:
            entities = pipeline(window_text)
        except Exception as e:
            logger.warning("NER boundary window failed at pos %d: %s", pos, e)
            pos += _WINDOW_SIZE - _WINDOW_OVERLAP
            continue

        for ent in entities:
            if ent["entity_group"] != "AUTHORS":
                continue
            if ent["score"] < _MIN_AUTHOR_SCORE:
                continue

            abs_start = pos + ent["start"]
            abs_end = pos + ent["end"]

            # Deduplicate overlapping spans from window overlap
            is_dup = False
            for existing in author_spans:
                if abs_start >= existing["start"] and abs_end <= existing["end"]:
                    is_dup = True
                    break
                if abs_start <= existing["start"] and abs_end >= existing["end"]:
                    # New span is larger — replace
                    existing["start"] = abs_start
                    existing["end"] = abs_end
                    existing["score"] = max(existing["score"], ent["score"])
                    is_dup = True
                    break
            if not is_dup:
                author_spans.append({
                    "start": abs_start,
                    "end": abs_end,
                    "score": ent["score"],
                })

        # Advance window
        if window_end >= len(text):
            break
        pos += _WINDOW_SIZE - _WINDOW_OVERLAP

    # Sort by position
    author_spans.sort(key=lambda s: s["start"])
    return author_spans


def _detect_boundaries(
    author_spans: list[dict], concat_text: str
) -> list[int]:
    """Identify reference boundary character offsets from author span positions.

    A boundary occurs where:
    1. It's the first author span, OR
    2. There's a gap between the previous author span's end and this span's start
       that contains sentence-ending punctuation (period, closing bracket, etc.)
       suggesting a previous reference ended.
    """
    if not author_spans:
        return []

    boundaries = []

    for i, span in enumerate(author_spans):
        if i == 0:
            # First author span — always a boundary
            boundaries.append(span["start"])
            continue

        prev_span = author_spans[i - 1]
        gap_start = prev_span["end"]
        gap_end = span["start"]

        # If spans overlap or are adjacent, they're part of the same reference
        if gap_end <= gap_start + 2:
            continue

        gap_text = concat_text[gap_start:gap_end]

        # A new reference boundary if the gap contains substantial content
        # (title, journal, year, DOI, etc.) between author sections
        # Heuristic: gap must be >30 chars (short gaps are author continuations like "& Smith")
        if len(gap_text.strip()) < 30:
            continue

        # Look for sentence-ending patterns in the gap that indicate
        # the previous reference has ended
        has_ending = bool(re.search(
            r"[.!?]\s*$|"               # ends with period
            r"\.\s+[A-Z]|"             # period + capital (new sentence)
            r"\d{4}[.)]\s|"            # year followed by separator
            r"doi[:\s]+10\.|"          # DOI
            r"https?://",              # URL
            gap_text
        ))

        if has_ending:
            # Find the actual start of this new reference in the concat text.
            # Walk backwards from span["start"] to find where the reference text begins
            # (could be a few chars before the author if there's whitespace/numbering)
            ref_start = _find_ref_text_start(concat_text, span["start"])
            boundaries.append(ref_start)

    return boundaries


def _find_ref_text_start(text: str, author_start: int) -> int:
    """Find the actual start of a reference given where its author span begins.

    Walks backward past whitespace and possible leading punctuation to find
    where the reference text truly starts.
    """
    pos = author_start
    # Skip back past whitespace
    while pos > 0 and text[pos - 1] in " \t\n":
        pos -= 1
    # If we're at a sentence boundary (period, etc.), the ref starts after it
    if pos > 0 and text[pos - 1] in ".!?;":
        return pos
    # Otherwise the author start is the boundary
    return author_start


def _split_at_boundaries(
    boundaries: list[int],
    concat_text: str,
    block_spans: list[tuple[int, int, int]],
    blocks: list[tuple[int, TextBlock]],
    pdf_id: str,
) -> list[SourceRectangle]:
    """Split concatenated text at boundary positions into SourceRectangles."""
    if not boundaries:
        return []

    # Add end sentinel
    segments = []
    for i, start in enumerate(boundaries):
        end = boundaries[i + 1] if i + 1 < len(boundaries) else len(concat_text)
        text = concat_text[start:end].strip()
        if text and len(text) >= 20:
            segments.append((start, end, text))

    # Map each segment back to its source blocks
    sources = []
    for ref_num, (seg_start, seg_end, seg_text) in enumerate(segments, 1):
        # Find which blocks overlap this segment
        ref_blocks = []
        for blk_start, blk_end, blk_idx in block_spans:
            if blk_end > seg_start and blk_start < seg_end:
                ref_blocks.append(blocks[blk_idx])

        if not ref_blocks:
            continue

        # Check it looks like a reference (has a year)
        if not re.search(r"(?:19|20)\d{2}", seg_text):
            continue

        source = _create_source(ref_blocks, seg_text, ref_num, pdf_id)
        if source:
            sources.append(source)

    return sources


def _create_source(
    blocks: list[tuple[int, TextBlock]],
    text: str,
    ref_num: int,
    pdf_id: str,
) -> SourceRectangle | None:
    """Create a SourceRectangle from blocks forming one reference."""
    if not blocks or not text.strip():
        return None

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
