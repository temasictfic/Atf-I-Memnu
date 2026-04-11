"""Investigation script: analyze reference detection on bad vs good PDFs."""

import sys
import re
from pathlib import Path

# Add backend to path
sys.path.insert(0, str(Path(__file__).parent))

from services.pdf_parser import parse_pdf
from services.reference_detector import (
    detect_references,
    _find_reference_header,
    _filter_reference_blocks,
    _extract_ref_number,
    HEADER_PATTERNS,
    REF_NUMBER_PATTERNS,
)

KAYNAKLAR_DIR = Path(__file__).parent.parent / "kaynaklar"

def analyze_pdf(pdf_name: str, verbose: bool = True):
    """Parse a PDF and run reference detection, printing diagnostics."""
    pdf_path = KAYNAKLAR_DIR / f"{pdf_name}.pdf"
    if not pdf_path.exists():
        print(f"\n{'='*80}")
        print(f"  {pdf_name}: FILE NOT FOUND at {pdf_path}")
        print(f"{'='*80}")
        return

    print(f"\n{'='*80}")
    print(f"  ANALYZING: {pdf_name}")
    print(f"{'='*80}")

    doc = parse_pdf(str(pdf_path))
    print(f"  Pages: {len(doc.pages)}")
    total_blocks = sum(len(p.text_blocks) for p in doc.pages)
    print(f"  Total text blocks: {total_blocks}")

    # Build all_blocks list (same as detect_references does)
    all_blocks = []
    for page in doc.pages:
        for block in page.text_blocks:
            all_blocks.append((page.page_num, block))

    # Step 1: Find reference header
    ref_start_idx = _find_reference_header(all_blocks)
    if ref_start_idx is None:
        print(f"\n  *** REFERENCE HEADER NOT FOUND ***")
        # Show last 3 pages to see what we're dealing with
        print(f"\n  --- Searching for header-like text across all blocks ---")
        for idx, (page_num, block) in enumerate(all_blocks):
            text = block.text.strip()
            text_lower = text.lower()
            if any(kw in text_lower for kw in ["kaynak", "kaynakça", "reference", "bibliography", "literat"]):
                print(f"    Block #{idx} [page {page_num}] bold={block.is_bold} len={len(text)}: {text[:120]}")

        # Also show last 40 blocks to see what's at the end
        print(f"\n  --- Last 40 text blocks ---")
        for idx, (page_num, block) in enumerate(all_blocks[-40:]):
            actual_idx = len(all_blocks) - 40 + idx
            text = block.text.strip()
            print(f"    Block #{actual_idx} [page {page_num}] bold={block.is_bold} font={block.font_name} size={block.font_size:.1f}: {text[:120]}")
        return

    header_page, header_block = all_blocks[ref_start_idx]
    print(f"  Reference header found at block #{ref_start_idx} on page {header_page}")
    print(f"    Header text: '{header_block.text.strip()[:100]}'")
    print(f"    Header bold: {header_block.is_bold}, font: {header_block.font_name}, size: {header_block.font_size}")

    # Step 2: Get blocks after header
    ref_blocks = all_blocks[ref_start_idx + 1:]
    print(f"\n  Blocks after header: {len(ref_blocks)}")

    # Step 3: Filter
    filtered_blocks = _filter_reference_blocks(ref_blocks)
    print(f"  Blocks after filtering: {len(filtered_blocks)}")
    removed = len(ref_blocks) - len(filtered_blocks)
    if removed > 0:
        print(f"  Blocks removed by filter: {removed}")

    # Step 4: Check for numbered refs
    numbered_count = 0
    for page_num, block in filtered_blocks:
        text = block.text.strip()
        ref_num = _extract_ref_number(text)
        if ref_num is not None:
            numbered_count += 1
    print(f"  Blocks with reference numbers: {numbered_count}")

    # Step 5: Show all filtered blocks (the input to the splitting algorithm)
    if verbose:
        print(f"\n  --- All filtered reference blocks ---")
        for i, (page_num, block) in enumerate(filtered_blocks):
            text = block.text.strip()
            ref_num = _extract_ref_number(text)
            marker = f"[REF #{ref_num}]" if ref_num is not None else "         "
            print(f"    {marker} [page {page_num}] bold={block.is_bold} size={block.font_size:.1f} bbox=[{block.bbox[0]:.0f},{block.bbox[1]:.0f},{block.bbox[2]:.0f},{block.bbox[3]:.0f}]: {text[:150]}")

    # Step 6: Run actual detection
    sources, _ = detect_references(doc)
    print(f"\n  === DETECTED SOURCES: {len(sources)} ===")
    for s in sources:
        print(f"    Ref #{s.ref_number}: page={s.bbox.page} | {s.text[:120]}")

    # Step 7: Summarize issues
    print(f"\n  --- Summary ---")
    print(f"    Header found: {'Yes' if ref_start_idx is not None else 'No'}")
    print(f"    Raw blocks after header: {len(ref_blocks)}")
    print(f"    Filtered blocks: {len(filtered_blocks)}")
    print(f"    Numbered blocks: {numbered_count}")
    print(f"    Final sources detected: {len(sources)}")

    return sources


if __name__ == "__main__":
    # "Very bad" PDFs (that exist in the directory)
    very_bad = ["126E147", "126E150", "126E152", "126E154", "126E167", "126E180", "126E181", "126E184"]
    # "Bad/messy"
    bad_messy = ["126E156", "126E178", "126R027"]
    # "Half missing"
    half_missing = ["126E179"]
    # Good (for comparison)
    good = ["126E146"]

    # Check which files exist
    print("Available PDFs:")
    for name in very_bad + bad_messy + half_missing + good:
        path = KAYNAKLAR_DIR / f"{name}.pdf"
        status = "EXISTS" if path.exists() else "MISSING"
        print(f"  {name}: {status}")

    print("\n" + "#"*80)
    print("#  GOOD PDF (for comparison)")
    print("#"*80)
    for name in good:
        analyze_pdf(name, verbose=True)

    print("\n" + "#"*80)
    print("#  VERY BAD PDFs")
    print("#"*80)
    for name in ["126E147", "126E154", "126E180", "126E181", "126E184"]:
        analyze_pdf(name, verbose=True)

    print("\n" + "#"*80)
    print("#  BAD/MESSY PDFs")
    print("#"*80)
    for name in bad_messy:
        analyze_pdf(name, verbose=True)

    print("\n" + "#"*80)
    print("#  HALF MISSING")
    print("#"*80)
    for name in half_missing:
        analyze_pdf(name, verbose=True)
