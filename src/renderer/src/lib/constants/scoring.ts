// Score thresholds shared across the renderer.
//
// Mirror of backend/services/scoring_constants.py — keep in sync. The two
// files are the single source of truth for status banding; literals in UI
// code or PDF export logic must consume one of these constants, not
// duplicate them.
//
// Bands:
//   score >= STATUS_FOUND_THRESHOLD       → "found"       (UI: High / Yüksek)
//   score >= STATUS_PROBLEMATIC_THRESHOLD → "problematic" (UI: Medium / Orta)
//   otherwise                              → "not_found"   (UI: Low / Düşük)

export const STATUS_FOUND_THRESHOLD = 0.75
export const STATUS_PROBLEMATIC_THRESHOLD = 0.5
export const TITLE_MATCH_THRESHOLD = 0.85
export const DOI_MATCH_MIN_SCORE = 0.5
