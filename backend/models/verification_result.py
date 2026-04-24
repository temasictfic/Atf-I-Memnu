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


class VerificationResult(BaseModel):
    source_id: str
    # Status values: pending, in_progress, found, problematic, not_found
    status: str = "pending"
    # Problem tags — values:
    # "!authors", "!doi/arXiv", "!year", "!source", "!title"
    problem_tags: list[str] = []
    # Trust-tag outcome from classify_trust(): "clean", "künye", or "uydurma"
    trust_tag: str = "clean"
    # Three-state trust-tag user override. None = use classify_trust() result.
    # Cycled from the UI via POST /api/verify/trust-override.
    trust_tag_override: str | None = None
    # Per-tag user overrides for the card's clickable chips.
    # Keys: "authors", "year", "title", "source", "doi/arXiv".
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
