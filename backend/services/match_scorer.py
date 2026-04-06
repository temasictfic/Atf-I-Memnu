"""Score matches between source references and search results using multi-signal approach."""

import re
from typing import Any

from rapidfuzz import fuzz

from models.source import ParsedSource
from models.verification_result import MatchDetails, MatchResult
from utils.doi_extractor import extract_arxiv_id, normalize_doi


def score_match(source: ParsedSource, candidate: dict[str, Any]) -> MatchResult:
    """Score a candidate result against a source reference.

    candidate dict expected keys: title, authors, year, doi, url, database, search_url
    """
    details = MatchDetails()

    # 1. Exact DOI match (with normalization)
    if source.doi and candidate.get("doi"):
        source_doi = normalize_doi(source.doi)
        cand_doi = normalize_doi(candidate["doi"])
        if source_doi == cand_doi:
            return MatchResult(
                database=candidate.get("database", ""),
                title=candidate.get("title", ""),
                authors=candidate.get("authors", []),
                year=candidate.get("year"),
                doi=candidate.get("doi"),
                url=candidate.get("url", ""),
                search_url=candidate.get("search_url", ""),
                score=1.0,
                match_details=MatchDetails(
                    title_similarity=1.0,
                    author_match=1.0,
                    year_match=1.0,
                    journal_match=1.0,
                ),
            )

    # 2. URL-based identifier matching (arXiv IDs, DOI in URLs)
    url_score = _url_match_score(source, candidate)
    if url_score >= 1.0:
        return MatchResult(
            database=candidate.get("database", ""),
            title=candidate.get("title", ""),
            authors=candidate.get("authors", []),
            year=candidate.get("year"),
            doi=candidate.get("doi"),
            url=candidate.get("url", ""),
            search_url=candidate.get("search_url", ""),
            score=1.0,
            match_details=MatchDetails(
                title_similarity=1.0,
                author_match=1.0,
                year_match=1.0,
                journal_match=1.0,
            ),
        )

    # 3. Title similarity (fuzzy)
    title_score = 0.0
    if source.title and candidate.get("title"):
        title_score = (
            fuzz.token_sort_ratio(
                source.title.lower(),
                candidate["title"].lower(),
            )
            / 100.0
        )
    details.title_similarity = title_score

    # 4. Author match
    author_score = _compare_authors(source.authors, candidate.get("authors", []))
    details.author_match = author_score

    # 5. Year match
    year_score = 0.0
    if source.year and candidate.get("year"):
        diff = abs(source.year - candidate["year"])
        if diff == 0:
            year_score = 1.0
        elif diff == 1:
            year_score = 0.5
    details.year_match = year_score

    # 6. Journal match
    journal_score = 0.0
    if source.journal and candidate.get("journal"):
        journal_score = (
            fuzz.token_sort_ratio(
                source.journal.lower(),
                candidate["journal"].lower(),
            )
            / 100.0
        )
    details.journal_match = journal_score

    # Composite score — adjust weights based on parse confidence
    if source.parse_confidence < 0.3 or source.authors == []:
        # Low confidence: other fields may be wrong, rely mainly on title
        composite = title_score
    else:
        composite = (
            title_score * 0.75
            + author_score * 0.25
        )

    return MatchResult(
        database=candidate.get("database", ""),
        title=candidate.get("title", ""),
        authors=candidate.get("authors", []),
        year=candidate.get("year"),
        doi=candidate.get("doi"),
        url=candidate.get("url", ""),
        search_url=candidate.get("search_url", ""),
        score=round(composite, 4),
        match_details=details,
    )


def determine_status(score: float) -> str:
    """Determine verification status from match score."""
    if score >= 0.75:
        return "green"
    elif score >= 0.50:
        return "yellow"
    elif score > 0:
        return "red"
    else:
        return "black"


def _url_match_score(source: ParsedSource, candidate: dict[str, Any]) -> float:
    """Check for matching identifiers embedded in URLs."""
    source_url = source.url or ""
    cand_url = candidate.get("url", "")

    # arXiv ID matching — strip version suffix before comparing so that
    # "2010.11929" (source, no version) matches "2010.11929v2" (candidate).
    s_arxiv = extract_arxiv_id(source_url) or extract_arxiv_id(source.raw_text)
    c_arxiv = extract_arxiv_id(cand_url)
    if s_arxiv and c_arxiv:
        s_base = re.sub(r"v\d+$", "", s_arxiv)
        c_base = re.sub(r"v\d+$", "", c_arxiv)
        if s_base and c_base and s_base == c_base:
            return 1.0

    # DOI in URL matching
    if "doi.org" in source_url and "doi.org" in cand_url:
        s_doi = normalize_doi(source_url)
        c_doi = normalize_doi(cand_url)
        if s_doi and c_doi and s_doi == c_doi:
            return 1.0

    return 0.0


def _compare_authors(source_authors: list[str], candidate_authors: list[str]) -> float:
    """Compare author lists using fuzzy last-name matching."""
    if not source_authors or not candidate_authors:
        return 0.0

    source_last = [_extract_last_name(a).lower() for a in source_authors]
    cand_last = [_extract_last_name(a).lower() for a in candidate_authors]

    if not source_last or not cand_last:
        return 0.0

    matches = 0
    for s_name in source_last:
        for c_name in cand_last:
            if fuzz.ratio(s_name, c_name) > 80:
                matches += 1
                break

    return matches / len(source_last)


def _extract_last_name(author: str) -> str:
    """Extract last name from author string, handling all citation formats."""
    author = author.strip().rstrip(".")

    # IEEE: "G. Liu" or "K. Y. Lee" — initials first, last name at end
    ieee_match = re.match(r"^(?:[A-Z]\.?\s*)+([A-Z][a-z]+)", author)
    if ieee_match and re.match(r"^[A-Z]\.", author):
        return ieee_match.group(1).strip()

    # Vancouver: "Liu G" or "Liu GH" — last name first, bare initials at end
    vanc_match = re.match(r"^([A-Z][a-z]+)\s+[A-Z]{1,3}$", author)
    if vanc_match:
        return vanc_match.group(1).strip()

    # Standard: "Liu, G." or "Liu, George" — last name before comma
    parts = author.split(",")
    if parts:
        return parts[0].strip()

    # Fallback: last word
    parts = author.split()
    if parts:
        return parts[-1].strip()

    return author
