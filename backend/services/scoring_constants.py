"""Score thresholds shared across the backend.

Mirror of ``src/renderer/src/lib/constants/scoring.ts`` — keep in sync. The
two files are the single source of truth for status banding; literals in UI
code or PDF export logic must consume one of these constants, not duplicate
them.

Bands:
- score >= STATUS_FOUND_THRESHOLD       → "found"       (UI: High / Yüksek)
- score >= STATUS_PROBLEMATIC_THRESHOLD → "problematic" (UI: Medium / Orta)
- otherwise                              → "not_found"   (UI: Low / Düşük)
"""

STATUS_FOUND_THRESHOLD = 0.75
STATUS_PROBLEMATIC_THRESHOLD = 0.50
TITLE_MATCH_THRESHOLD = 0.85
DOI_MATCH_MIN_SCORE = 0.50
