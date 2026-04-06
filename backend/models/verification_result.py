from pydantic import BaseModel


class MatchDetails(BaseModel):
    title_similarity: float = 0.0
    author_match: float = 0.0
    year_match: float = 0.0
    journal_match: float = 0.0


class MatchResult(BaseModel):
    database: str
    title: str = ""
    authors: list[str] = []
    year: int | None = None
    doi: str | None = None
    url: str = ""
    search_url: str = ""
    score: float = 0.0
    match_details: MatchDetails = MatchDetails()


class VerificationResult(BaseModel):
    source_id: str
    status: str = "pending"  # pending, in_progress, green, yellow, red, black
    best_match: MatchResult | None = None
    all_results: list[MatchResult] = []
    databases_searched: list[str] = []
