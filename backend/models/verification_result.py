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
    # "!authors", "!doi/arXiv", "!url", "!year", "!source"
    problem_tags: list[str] = []
    # URL -> liveness map (for non-doi/arXiv URLs that were checked)
    url_liveness: dict[str, bool] = {}
    best_match: MatchResult | None = None
    all_results: list[MatchResult] = []
    databases_searched: list[str] = []
