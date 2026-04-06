"""Parse PDF files using PyMuPDF, extracting text blocks with bounding box coordinates."""

import base64
from pathlib import Path

import fitz  # PyMuPDF

from models.pdf_document import PdfDocument, PageContent, TextBlock


DPI = 150
SCALE = DPI / 72.0  # PDF points to pixels


def parse_pdf(pdf_path: str) -> PdfDocument:
    """Parse a PDF file and extract text blocks with coordinates + page images."""
    path = Path(pdf_path)
    doc = fitz.open(pdf_path)

    pdf_id = path.stem
    pages: list[PageContent] = []

    for page_num in range(len(doc)):
        page = doc[page_num]
        page_dict = page.get_text("dict", flags=fitz.TEXT_PRESERVE_WHITESPACE)

        # Extract text at LINE level (not block level) for better granularity.
        # PyMuPDF blocks can merge many references into one block, but lines
        # within blocks give us individual-line bounding boxes.
        text_blocks: list[TextBlock] = []
        for block in page_dict.get("blocks", []):
            if block.get("type") != 0:  # 0 = text block
                continue

            for line in block.get("lines", []):
                line_text_parts = []
                line_font_size = 0.0
                line_font_name = ""
                is_bold = False

                for span in line.get("spans", []):
                    text = span.get("text", "").strip()
                    if text:
                        line_text_parts.append(text)
                        line_font_size = max(line_font_size, span.get("size", 0))
                        line_font_name = span.get("font", "")
                        if "bold" in line_font_name.lower() or "Bold" in line_font_name:
                            is_bold = True

                full_text = " ".join(line_text_parts)
                if not full_text.strip():
                    continue

                bbox = line.get("bbox", block.get("bbox", [0, 0, 0, 0]))
                text_blocks.append(TextBlock(
                    text=full_text,
                    bbox=[b * SCALE for b in bbox],  # Convert to pixel coordinates
                    page=page_num,
                    font_size=line_font_size,
                    font_name=line_font_name,
                    is_bold=is_bold,
                ))

        # Render page to image
        pixmap = page.get_pixmap(dpi=DPI)
        img_bytes = pixmap.tobytes("png")
        img_base64 = base64.b64encode(img_bytes).decode("utf-8")

        pages.append(PageContent(
            page_num=page_num,
            width=page.rect.width * SCALE,
            height=page.rect.height * SCALE,
            text_blocks=text_blocks,
            image_base64=img_base64,
        ))

    doc.close()

    return PdfDocument(
        id=pdf_id,
        name=path.name,
        path=pdf_path,
        status="parsed",
        pages=pages,
    )
