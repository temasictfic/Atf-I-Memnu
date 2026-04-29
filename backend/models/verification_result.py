from pydantic import BaseModel


class MatchDetails(BaseModel):
    title_similarity: float = 0.0
    author_match: float = 0.0
    year_match: float = 0.0
    url_match: bool = False  # unified: doi, arXiv, or other URL matches


class MatchResult(BaseModel):
    database: str
    title: str = ""
    authors: list[str] = []
    year: int | None = None
    doi: str | None = None
    journal: str = ""
    url: str = ""
    search_url: str = ""
    score: float = 0.0
    match_details: MatchDetails = MatchDetails()
    # Bibliographic extras — populated by verifiers when the underlying API
    # returns the field. Display-only; never used in scoring.
    volume: str | None = None
    issue: str | None = None
    pages: str | None = None
    publisher: str = ""
    editor: list[str] = []
    document_type: str = ""  # article / book / chapter / thesis / preprint / report
    language: str = ""  # ISO 639-1
    issn: list[str] = []
    isbn: list[str] = []


class VerificationResult(BaseModel):
    source_id: str
    # Status values: pending, in_progress, high, medium, low
    status: str = "pending"
    # Problem tags — values:
    # "!authors", "!doi/arXiv", "!year", "!journal", "!title"
    problem_tags: list[str] = []
    # Decision-tag outcome from classify_decision(): "valid", "citation", or "fabricated"
    decision_tag: str = "valid"
    # Three-state decision-tag user override. None = use classify_decision() result.
    # Cycled from the UI via POST /api/verify/decision-override.
    decision_tag_override: str | None = None
    # Per-tag user overrides for the card's clickable chips.
    # Keys: "authors", "year", "title", "journal", "doi/arXiv".
    # true = force ON, false = force OFF, missing key = use default logic.
    tag_overrides: dict[str, bool] = {}
    # URL -> liveness map (for non-doi/arXiv URLs that were checked)
    url_liveness: dict[str, bool] = {}
    best_match: MatchResult | None = None
    all_results: list[MatchResult] = []
    databases_searched: list[str] = []
    # Pre-built Google Scholar / Google Search URLs using the NER-extracted title
    scholar_url: str = ""
    google_url: str = ""
