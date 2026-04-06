from pydantic import BaseModel


class TextBlock(BaseModel):
    text: str
    bbox: list[float]  # [x0, y0, x1, y1]
    page: int
    font_size: float = 0.0
    font_name: str = ""
    is_bold: bool = False


class PageContent(BaseModel):
    page_num: int
    width: float
    height: float
    text_blocks: list[TextBlock]
    image_base64: str = ""  # Page rendered as PNG base64


class PdfDocument(BaseModel):
    id: str
    name: str
    path: str
    status: str = "pending"  # pending, parsing, parsed, approved, error
    source_count: int = 0
    pages: list[PageContent] = []
    error: str | None = None
