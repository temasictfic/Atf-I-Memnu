"""Score matches between source sources and search results using multi-signal approach."""

import re
from typing import Any

from rapidfuzz import fuzz

from models.source import ParsedSource
from models.verification_result import MatchDetails, MatchResult
from services.author_matcher import author_score, authors_match
from services.scoring_constants import (
    COMPOSITE_AUTHOR_WEIGHT,
    COMPOSITE_TITLE_WEIGHT,
    DOI_MATCH_MIN_SCORE,
    FIELD_MATCH_BONUS,
    LOW_PARSE_CONFIDENCE_THRESHOLD,
    STATUS_HIGH_THRESHOLD,
    STATUS_MEDIUM_THRESHOLD,
    TITLE_MATCH_THRESHOLD,
    TITLE_SEQUENTIAL_WEIGHT,
    TITLE_TOKEN_SORT_WEIGHT,
    VENUE_FUZZY_MATCH_THRESHOLD,
    YEAR_EXACT_SCORE,
    YEAR_OFF_BY_ONE_SCORE,
)
from utils.doi_extractor import extract_arxiv_id, normalize_doi

__all__ = [
    "DOI_MATCH_MIN_SCORE",
    "STATUS_HIGH_THRESHOLD",
    "STATUS_MEDIUM_THRESHOLD",
    "TITLE_MATCH_THRESHOLD",
    "classify_decision",
    "determine_verification_status",
    "score_match",
]


def score_match(source: ParsedSource, candidate: dict[str, Any]) -> MatchResult:
    """Score a candidate result against a source source.

    candidate dict expected keys: title, authors, year, doi, url, database, search_url
    """
    details = MatchDetails()

    # 1. Title similarity (fuzzy)
    title_score = 0.0
    if source.title and candidate.get("title"):
        src_lower = source.title.lower()
        cand_lower = candidate["title"].lower()
        token_sort = fuzz.token_sort_ratio(src_lower, cand_lower) / 100.0
        sequential = fuzz.ratio(src_lower, cand_lower) / 100.0
        title_score = TITLE_TOKEN_SORT_WEIGHT * token_sort + TITLE_SEQUENTIAL_WEIGHT * sequential
    details.title_similarity = title_score

    # 2. Author match
    author_match_score = _compare_authors(source.authors, candidate.get("authors", []))
    details.author_match = author_match_score

    # 3. Year match
    year_score = 0.0
    if source.year and candidate.get("year"):
        diff = abs(source.year - candidate["year"])
        if diff == 0:
            year_score = YEAR_EXACT_SCORE
        elif diff == 1:
            year_score = YEAR_OFF_BY_ONE_SCORE
    details.year_match = year_score

    # 4. URL match (covers doi, arXiv, and other URLs)
    details.url_match = _urls_match(source, candidate)
    # DOIs / arXiv IDs are identifier-style — there's no meaningful partial
    # match, so this is a binary float that mirrors url_match for visibility.
    details.doi_arxiv_similarity = 1.0 if details.url_match else 0.0

    # 5. Journal / venue similarity (informational — venue *threshold* lives
    # in _venues_match for problem-tag logic; here we surface the raw score).
    details.journal_similarity = _venue_similarity_score(
        source.journal or "", candidate.get("journal") or ""
    )

    # Base composite — title+author weighted mix, falling back to title-only
    # when the source was parsed with low confidence or has no authors.
    if source.parse_confidence < LOW_PARSE_CONFIDENCE_THRESHOLD or source.authors == []:
        base = title_score
    else:
        base = title_score * COMPOSITE_TITLE_WEIGHT + author_match_score * COMPOSITE_AUTHOR_WEIGHT

    # Field-match bonuses: +FIELD_MATCH_BONUS each when source HAS the field
    # AND it matches the candidate. Gated on "source has field" so missing
    # metadata can't silently inflate a score. Final composite clamped to [0, 1].
    bonus = 0.0
    if source.year and candidate.get("year") and abs(source.year - candidate["year"]) <= 1:
        bonus += FIELD_MATCH_BONUS

    src_venue = (source.journal or "").strip()
    cand_venue = (candidate.get("journal") or "").strip()
    if src_venue and cand_venue and _venues_match(src_venue, cand_venue):
        bonus += FIELD_MATCH_BONUS

    if (source.doi or source.arxiv_id) and details.url_match:
        bonus += FIELD_MATCH_BONUS

    composite = max(0.0, min(1.0, base + bonus))

    return MatchResult(
        database=candidate.get("database", ""),
        title=candidate.get("title", ""),
        authors=candidate.get("authors", []),
        year=candidate.get("year"),
        doi=candidate.get("doi"),
        journal=candidate.get("journal", ""),
        url=candidate.get("url", ""),
        search_url=candidate.get("search_url", ""),
        score=round(composite, 4),
        match_details=details,
        volume=candidate.get("volume"),
        issue=candidate.get("issue"),
        pages=candidate.get("pages"),
        publisher=candidate.get("publisher", ""),
        editor=candidate.get("editor", []),
        document_type=candidate.get("document_type", ""),
        language=candidate.get("language", ""),
        issn=candidate.get("issn", []),
        isbn=candidate.get("isbn", []),
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


def determine_verification_status(
    source: ParsedSource,
    best_match: MatchResult | None,
    url_liveness: dict[str, bool] | None = None,
) -> tuple[str, list[str]]:
    """Score-banded status + per-signal problem tags.

    Status is derived purely from the composite score (no title-only gate):
      >= STATUS_HIGH_THRESHOLD   → "high"
      >= STATUS_MEDIUM_THRESHOLD → "medium"
      otherwise                   → "low"

    Problem tags are emitted independently of the status band so the five
    card chips stay in sync with per-signal reality:
      !authors    — source has authors AND authors_match() is False
      !year       — source.year AND bm.year AND |diff| > 1
      !journal    — source.journal AND bm.journal AND !_venues_match
      !doi/arXiv  — (source.doi OR source.arxiv_id) AND NOT bm.url_match
      !title      — bm present AND title_similarity < TITLE_MATCH_THRESHOLD

    A missing source-side field emits no tag (nothing to disagree with).
    """
    url_liveness = url_liveness or {}

    if best_match is None:
        return "low", []

    tags: list[str] = []

    # Chip rules for {authors, year, source, doi/arXiv} — per-field presence
    # is evaluated on BOTH sides:
    #   both sides have the field, they match       → OFF
    #   both sides have the field, they disagree    → ON
    #   only one side has the field                  → ON
    #   neither side has the field                   → OFF (nothing to compare)
    # Title uses its own similarity threshold (below) — a missing title
    # collapses similarity to 0, so `!title` fires naturally.

    src_has_authors = bool(source.authors)
    bm_has_authors = bool(best_match.authors)
    if src_has_authors and bm_has_authors:
        if not authors_match(source.authors, best_match.authors):
            tags.append("!authors")
    elif src_has_authors != bm_has_authors:
        tags.append("!authors")

    src_has_year = source.year is not None
    bm_has_year = best_match.year is not None
    if src_has_year and bm_has_year:
        if abs(source.year - best_match.year) > 1:
            tags.append("!year")
    elif src_has_year != bm_has_year:
        tags.append("!year")

    src_has_venue = bool((source.journal or "").strip())
    bm_has_venue = bool((best_match.journal or "").strip())
    if src_has_venue and bm_has_venue:
        if not _venues_match(source.journal, best_match.journal):
            tags.append("!journal")
    elif src_has_venue != bm_has_venue:
        tags.append("!journal")

    src_has_ident = bool(source.doi or source.arxiv_id)
    bm_has_ident = bool(best_match.doi) or "arxiv.org" in (best_match.url or "")
    if src_has_ident and bm_has_ident:
        if not best_match.match_details.url_match:
            tags.append("!doi/arXiv")
    elif src_has_ident != bm_has_ident:
        tags.append("!doi/arXiv")

    if best_match.match_details.title_similarity < TITLE_MATCH_THRESHOLD:
        tags.append("!title")

    score = best_match.score
    if score >= STATUS_HIGH_THRESHOLD:
        status = "high"
    elif score >= STATUS_MEDIUM_THRESHOLD:
        status = "medium"
    else:
        status = "low"
    return status, tags


# ----- Decision tag (Citation / Fabricated) decision tree -----------------

def classify_decision(
    source: ParsedSource,
    best_match: MatchResult | None,
) -> str:
    """Classify a source as "valid" | "citation" | "fabricated".

    Per-signal "matches" predicates mirror the chip display rule for
    authors / year / source / doi/arXiv:
      - both sides have the field and they agree   → matches
      - both sides are missing the field           → matches (no disagreement)
      - exactly one side has the field             → does NOT match
      - both have the field and they disagree      → does NOT match

    Title uses a similarity threshold instead:
      title_matches = title_similarity >= TITLE_MATCH_THRESHOLD

    Rule:
      all four of {author, year, title, source} match     → "valid"
      title matches
        OR (author matches AND any of {year, source, doi} matches) → "citation"
      otherwise                                           → "fabricated"
    """
    if best_match is None:
        return "fabricated"

    title_matches = (
        best_match.match_details.title_similarity >= TITLE_MATCH_THRESHOLD
    )

    src_has_authors = bool(source.authors)
    bm_has_authors = bool(best_match.authors)
    if src_has_authors and bm_has_authors:
        author_matches = authors_match(source.authors, best_match.authors)
    else:
        author_matches = not src_has_authors and not bm_has_authors

    src_has_year = source.year is not None
    bm_has_year = best_match.year is not None
    if src_has_year and bm_has_year:
        year_matches = abs(source.year - best_match.year) <= 1
    else:
        year_matches = not src_has_year and not bm_has_year

    src_has_venue = bool((source.journal or "").strip())
    bm_has_venue = bool((best_match.journal or "").strip())
    if src_has_venue and bm_has_venue:
        source_matches = _venues_match(source.journal, best_match.journal)
    else:
        source_matches = not src_has_venue and not bm_has_venue

    src_has_ident = bool(source.doi or source.arxiv_id)
    bm_has_ident = bool(best_match.doi) or "arxiv.org" in (best_match.url or "")
    if src_has_ident and bm_has_ident:
        doi_matches = best_match.match_details.url_match
    else:
        doi_matches = not src_has_ident and not bm_has_ident

    if author_matches and year_matches and title_matches and source_matches:
        return "valid"
    elif title_matches or (
        author_matches and (year_matches or source_matches or doi_matches)
    ):
        return "citation"
    else:
        return "fabricated"


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


# ----- Source venue (journal / conference / book) matching -----------------

# ISO-4 / NLM style abbreviation expansions. Tokens are matched after
# stripping trailing dots, lowercased.
_VENUE_ABBREV = {
    "j": "journal", "jnl": "journal", "jrnl": "journal",
    "trans": "transactions", "tr": "transactions",
    "proc": "proceedings", "procs": "proceedings",
    "conf": "conference", "symp": "symposium", "wkshp": "workshop",
    "int": "international", "intl": "international", "natl": "national",
    "am": "american", "amer": "american", "br": "british", "eur": "european",
    "assoc": "association", "soc": "society", "inst": "institute",
    "univ": "university", "rev": "review", "lett": "letters",
    "res": "research", "stud": "studies", "sci": "science",
    "eng": "engineering", "tech": "technology", "technol": "technology",
    "comp": "computer", "comput": "computer", "comm": "communications",
    "commun": "communications", "info": "information", "inf": "information",
    "med": "medical", "biol": "biology", "biomed": "biomedical",
    "phys": "physics", "chem": "chemistry", "math": "mathematics",
    "psychol": "psychology", "psych": "psychology",
    "educ": "education", "manag": "management", "mgmt": "management",
    "bus": "business", "econ": "economics",
    "appl": "applied", "theor": "theoretical", "exp": "experimental",
    "adv": "advances", "ann": "annals", "arch": "archives", "bull": "bulletin",
    "annu": "annual", "rep": "reports",
}

# Container venues that legitimately publish other conferences/workshops.
# When the candidate journal is one of these, a conference-style source name
# should not be flagged just because the strings differ.
_CONTAINER_SERIES = {
    "lecture notes in computer science",
    "lecture notes in artificial intelligence",
    "lecture notes in business information processing",
    "communications in computer and information science",
    "advances in intelligent systems and computing",
    "advances in neural information processing systems",
    "ceur workshop proceedings",
    "smart innovation systems and technologies",
    "ifip advances in information and communication technology",
    "studies in computational intelligence",
    "arxiv",
}

# Aggregator / host names that replace the real journal title and should
# never be compared as venues directly.
_AGGREGATORS = {
    "dergipark", "trdizin", "ulakbim", "doaj", "jstor", "ssrn",
    "researchgate", "academia.edu",
}


def _strip_parens(text: str) -> str:
    return re.sub(r"\s*\([^)]*\)\s*", " ", text)


def _canonicalise_venue(text: str) -> str:
    s = text.lower()
    s = _strip_parens(s)
    # Drop common leading framings
    s = re.sub(r"^\s*(in\s*[:\-]?\s*|in\s+proceedings\s+of\s+(the\s+)?|"
               r"proceedings\s+of\s+(the\s+)?|proc\.?\s+of\s+(the\s+)?|"
               r"the\s+)", "", s)
    # Drop trailing volume / issue / edition / year noise (word-bounded so
    # tokens like "notes" or "noise" aren't eaten by the "no" alternative).
    s = re.sub(r",?\s*\b(vol|volume|no|issue|pp|pages?|edition)\b\.?\s*[\w\-]*", " ", s)
    s = re.sub(r",?\s*\b\d{1,2}(st|nd|rd|th)\s+ed\b\.?", " ", s)
    s = re.sub(r",?\s*\b(19|20)\d{2}\b", " ", s)
    # Strip subtitle after a colon — keep the head only
    s = s.split(":", 1)[0]
    # Expand abbreviations token by token
    tokens = []
    for tok in re.split(r"[\s/,;]+", s):
        bare = tok.strip(".·•—-")
        if not bare:
            continue
        tokens.append(_VENUE_ABBREV.get(bare, bare))
    return " ".join(tokens)


_INITIALS_STOPWORDS = {"and", "of", "the", "in", "for", "on", "to", "a", "an", "&"}


def _initials(text: str) -> str:
    words = [w for w in re.findall(r"[A-Za-z]+", text) if w.lower() not in _INITIALS_STOPWORDS]
    return "".join(w[0] for w in words)


def _venue_similarity_score(source_venue: str, cand_journal: str) -> float:
    """Return a 0–1 similarity score between two venue strings.

    When either side is blank the score is 0.0 (no comparison made — caller
    can disambiguate via the source values themselves). When both sides are
    present, aggregator/container/initialism overrides return 1.0;
    otherwise the score is the max of token_sort and token_set fuzzy ratios
    on the canonicalised forms.
    """
    src_raw = (source_venue or "").strip()
    cand_raw = (cand_journal or "").strip()
    if not src_raw or not cand_raw:
        return 0.0

    src = _canonicalise_venue(src_raw)
    cand = _canonicalise_venue(cand_raw)
    if not src or not cand:
        return 0.0

    # Aggregator host on candidate side
    if any(agg in cand for agg in _AGGREGATORS):
        return 1.0

    # Container series on candidate side
    if any(series in cand for series in _CONTAINER_SERIES):
        return 1.0

    # Initialism: short/all-caps acronym vs expanded title
    short, long = (src_raw, cand_raw) if len(src_raw) <= len(cand_raw) else (cand_raw, src_raw)
    short_clean = re.sub(r"[^A-Za-z]", "", short)
    if 2 <= len(short_clean) <= 8 and short_clean.isupper():
        if short_clean.lower() == _initials(long).lower():
            return 1.0

    # Multi-strategy fuzzy. Deliberately omit partial_ratio — single-token
    # overlaps ("IEEE", "Sensors") inflate it and produce false negatives
    # on the !journal tag.
    return max(
        fuzz.token_sort_ratio(src, cand),
        fuzz.token_set_ratio(src, cand),
    ) / 100.0


def _venues_match(source_venue: str, cand_journal: str) -> bool:
    """True when the two venue strings plausibly refer to the same venue.

    Missing-side semantics: when either side is blank, returns True ("no
    disagreement to flag"). Caller-side problem-tag logic separately checks
    presence on each side. Otherwise threshold check on top of the fuzz
    score from :func:`_venue_similarity_score`.
    """
    src_raw = (source_venue or "").strip()
    cand_raw = (cand_journal or "").strip()
    if not src_raw or not cand_raw:
        return True
    return _venue_similarity_score(src_raw, cand_raw) >= VENUE_FUZZY_MATCH_THRESHOLD
