"""Score matches between source references and search results using multi-signal approach."""

import re
from typing import Any

from rapidfuzz import fuzz

from models.source import ParsedSource
from models.verification_result import MatchDetails, MatchResult
from services.author_matcher import author_score, authors_match
from utils.doi_extractor import extract_arxiv_id, normalize_doi


def score_match(source: ParsedSource, candidate: dict[str, Any]) -> MatchResult:
    """Score a candidate result against a source reference.

    candidate dict expected keys: title, authors, year, doi, url, database, search_url
    """
    details = MatchDetails()

    # 1. Title similarity (fuzzy)
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

    # 2. Author match
    author_score = _compare_authors(source.authors, candidate.get("authors", []))
    details.author_match = author_score

    # 3. Year match
    year_score = 0.0
    if source.year and candidate.get("year"):
        diff = abs(source.year - candidate["year"])
        if diff == 0:
            year_score = 1.0
        elif diff == 1:
            year_score = 0.5
    details.year_match = year_score

    # 4. URL match (covers doi, arXiv, and other URLs)
    details.url_match = _urls_match(source, candidate)

    # Composite score — adjust weights based on parse confidence.
    # NOTE: per Phase 4, DOI/arXiv match alone no longer guarantees a "found"
    # status — title+author still must verify. Composite reflects that here.
    if source.parse_confidence < 0.3 or source.authors == []:
        composite = title_score
    else:
        composite = title_score * 0.75 + author_score * 0.25

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


def _urls_match(source: ParsedSource, candidate: dict[str, Any]) -> bool:
    """True when the source and candidate share a DOI, arXiv ID, or URL."""
    # DOI match (use computed property on ParsedSource for backward compat)
    src_doi = source.doi
    cand_doi = candidate.get("doi")
    if src_doi and cand_doi:
        if normalize_doi(src_doi) == normalize_doi(cand_doi):
            return True

    # URL identifier matching (arXiv ID with version-suffix tolerance, DOI URL)
    return _url_match_score(source, candidate) >= 1.0


def determine_status(score: float) -> str:
    """Legacy: 4-category status from score. Kept for back-compat callers."""
    if score >= 0.65:
        return "green"
    elif score >= 0.50:
        return "yellow"
    elif score > 0:
        return "red"
    else:
        return "black"


# Thresholds for the 3-category determination
TITLE_FOUND_THRESHOLD = 0.85
TITLE_PROBLEMATIC_THRESHOLD = 0.75


def determine_verification_status(
    source: ParsedSource,
    best_match: MatchResult | None,
    url_liveness: dict[str, bool] | None = None,
) -> tuple[str, list[str]]:
    """Determine 3-category verification status with problem tags.

    Categories:
      - "found": title >= 0.85 AND authors verified AND
                 (no source DOI/arXiv OR matching DOI/arXiv in candidate)
      - "problematic": title >= 0.75 but some signal disagrees (tagged)
      - "not_found": no candidate with title >= 0.75

    Problem tags (only set when "problematic"):
      "!authors", "!doi/arXiv", "!url", "!year", "!publication"
    """
    url_liveness = url_liveness or {}

    if best_match is None:
        return "not_found", _not_found_url_tags(source, url_liveness)

    title = best_match.match_details.title_similarity
    if title < TITLE_PROBLEMATIC_THRESHOLD:
        return "not_found", _not_found_url_tags(source, url_liveness)

    # Title is at least problematic-level — collect signals
    tags: list[str] = []

    # Authors check: at least 50% of source author last names found in candidate
    authors_ok = _authors_satisfied(source, best_match)
    if not authors_ok:
        tags.append("!authors")

    # DOI/arXiv check: only if source has one — must match candidate's
    src_doi = source.doi
    src_arxiv = source.arxiv_id
    if src_doi or src_arxiv:
        if not best_match.match_details.url_match:
            tags.append("!doi/arXiv")

    # Year check (only if both have years)
    if source.year and best_match.year:
        if abs(source.year - best_match.year) > 1:
            tags.append("!year")

    # Publication / source venue check (only if both have it)
    cand_journal = _candidate_journal(best_match)
    if source.source and cand_journal:
        from rapidfuzz import fuzz
        sim = fuzz.token_sort_ratio(source.source.lower(), cand_journal.lower()) / 100.0
        if sim < 0.6:
            tags.append("!publication")

    # Non-DOI/arXiv URL liveness — flag dead links
    for url, alive in url_liveness.items():
        if not alive:
            tags.append("!url")
            break

    # Decision: found requires title >= FOUND threshold, no problems, authors ok
    if (
        title >= TITLE_FOUND_THRESHOLD
        and not tags
        and authors_ok
    ):
        return "found", []

    return "problematic", tags


def _authors_satisfied(source: ParsedSource, best_match: MatchResult) -> bool:
    """Verify source authors are present in candidate authors.

    Delegates to services.author_matcher.authors_match, which handles
    diacritics, IEEE/Vancouver/display-name formats, multi-part surnames,
    and initial-based disambiguation.
    """
    if not source.authors:
        return True
    return authors_match(source.authors, best_match.authors or [])


def _candidate_journal(best_match: MatchResult) -> str | None:
    """Best-effort extraction of the candidate's journal/venue name.

    Verifiers don't currently set a `journal` field on MatchResult, but the
    underlying candidate dict often had one.  We don't have access to it here,
    so this returns None unless we add that field later.  Kept as a hook so
    the !publication tag is opt-in.
    """
    return None


def _not_found_url_tags(source: ParsedSource, url_liveness: dict[str, bool]) -> list[str]:
    """For not_found status: only the !url tag is meaningful (dead link)."""
    if any(not alive for alive in url_liveness.values()):
        return ["!url"]
    return []


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
    """Return the fraction of source authors found in the candidate list."""
    return author_score(source_authors, candidate_authors)
