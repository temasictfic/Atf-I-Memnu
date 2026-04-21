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
        src_lower = source.title.lower()
        cand_lower = candidate["title"].lower()
        token_sort = fuzz.token_sort_ratio(src_lower, cand_lower) / 100.0
        sequential = fuzz.ratio(src_lower, cand_lower) / 100.0
        title_score = 0.6 * token_sort + 0.4 * sequential
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
        journal=candidate.get("journal", ""),
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

    Problem tags:
      "!authors", "!doi/arXiv", "!url", "!year", "!source"
    "!doi/arXiv", "!url", and "!source" are informational soft tags — they
    do not prevent a "found" status.
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
        if abs(source.year - best_match.year) >= 1:
            tags.append("!year")

    # Source venue check (journal / conference / book / etc.) — informational
    if source.source and best_match.journal:
        if not _venues_match(source.source, best_match.journal):
            tags.append("!source")

    # Non-DOI/arXiv URL liveness — flag dead links
    for url, alive in url_liveness.items():
        if not alive:
            tags.append("!url")
            break

    # Decision: found requires title >= FOUND threshold and authors ok.
    # !doi/arXiv and !url are tolerated (the reference is still considered
    # found when title+authors+year all agree) but the tags remain visible.
    soft_tags = {"!doi/arXiv", "!url", "!source"}
    if (
        title >= TITLE_FOUND_THRESHOLD
        and authors_ok
        and all(t in soft_tags for t in tags)
    ):
        return "found", tags

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


def _venues_match(source_venue: str, cand_journal: str) -> bool:
    """Robust venue comparison. Returns True when the two strings plausibly
    refer to the same venue.

    Strategy:
      1. Canonicalise both sides (lowercase, strip parens/prefix/suffix
         noise, expand ISO-4 abbreviations).
      2. Take the max over token_sort, token_set, and partial_ratio so that
         subtitle / extra-token cases pass.
      3. Initialism check: if one side is short/all-caps, compare against
         the initials of the other side (CVPR ↔ Computer Vision and Pattern
         Recognition).
      4. Container-series allow-list: LNCS / CCIS / NeurIPS proceedings etc.
         pass when the source looks like a conference or workshop.
      5. Aggregator hosts (DergiPark, TRDizin, ...) are treated as matching
         any source — they replace the real journal title.
    """
    src_raw = (source_venue or "").strip()
    cand_raw = (cand_journal or "").strip()
    if not src_raw or not cand_raw:
        return True  # nothing meaningful to compare

    src = _canonicalise_venue(src_raw)
    cand = _canonicalise_venue(cand_raw)
    if not src or not cand:
        return True

    # Aggregator host on candidate side
    if any(agg in cand for agg in _AGGREGATORS):
        return True

    # Container series on candidate side: accept unconditionally. The
    # title+author signals at the caller already establish the candidate
    # really is the cited work; a container-series journal name simply
    # means the publisher rolled the work into a series and shouldn't be
    # double-flagged.
    if any(series in cand for series in _CONTAINER_SERIES):
        return True

    # Multi-strategy fuzzy. Deliberately omit partial_ratio — single-token
    # overlaps ("IEEE", "Sensors") inflate it and produce false negatives
    # on the !source tag.
    best = max(
        fuzz.token_sort_ratio(src, cand),
        fuzz.token_set_ratio(src, cand),
    ) / 100.0
    if best >= 0.6:
        return True

    # Initialism: short/all-caps acronym vs expanded title
    short, long = (src_raw, cand_raw) if len(src_raw) <= len(cand_raw) else (cand_raw, src_raw)
    short_clean = re.sub(r"[^A-Za-z]", "", short)
    if 2 <= len(short_clean) <= 8 and short_clean.isupper():
        if short_clean.lower() == _initials(long).lower():
            return True

    return False
