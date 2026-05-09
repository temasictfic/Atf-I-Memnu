import type { ExclusionEntry } from '../utils/exclusion-list'

export type ExclusionInfo =
  | { excluded: true; reason: string; kind: 'user' | 'word' | 'non-doi-url' }
  | { excluded: false }

// Mirrors backend/models/source.py `_DOI_FROM_URL`. We keep matching loose
// (anywhere in the string, not just at the start) so a citation that reads
// "...available at https://doi.org/10.1234/abcd" still counts as DOI-bearing.
const DOI_URL_RE = /https?:\/\/(?:dx\.)?doi\.org\//i

// Any URL anywhere in the text. Used as the "is there a URL at all?" probe
// so we can tell "no URL" (not Muaf) from "URL but it isn't a DOI" (Muaf).
const ANY_URL_RE = /https?:\/\/\S+/i

interface Reasons {
  userDisabled: string
  nonDoiUrl: string
}

/**
 * Decide whether a card is Muaf (excluded from verification) and why.
 *
 * `override` is the renderer's `enabledSources[id]` value, raw — pass
 * `undefined` for "no user choice yet", `true` for explicit force-enable,
 * `false` for explicit user-disable.
 *
 * Priority (first match wins):
 *   1. `override === true` → user override beats every other rule. Not Muaf.
 *   2. Word from the exclusion file appears in the text → file's reason.
 *   3. The exclusion file declares `@non-doi-url` AND the text contains a
 *      URL that isn't a DOI link → directive's reason. Removing the
 *      `@non-doi-url` line from the file disables this rule.
 *   4. `override === false` → "User excluded it".
 *   5. Otherwise → not Muaf.
 *
 * The "user excluded it" reason only surfaces when no automatic rule
 * applies — clicking the ref-badge on an auto-Muaf card and then clicking
 * again returns the card to its automatic reason, not the user reason.
 */
export function computeExclusion(
  sourceText: string,
  override: boolean | undefined,
  exclusionEntries: ExclusionEntry[],
  reasons: Reasons,
): ExclusionInfo {
  if (override === true) return { excluded: false }

  const lower = sourceText.toLowerCase()
  let nonDoiUrlEntry: ExclusionEntry | null = null
  for (const entry of exclusionEntries) {
    if (entry.kind === 'non-doi-url') {
      // Remember it so step 3 can consult it after the word loop, but
      // don't try to substring-match the literal `@non-doi-url` token.
      nonDoiUrlEntry = entry
      continue
    }
    if (entry.word && lower.includes(entry.word)) {
      return { excluded: true, reason: entry.reason || entry.word, kind: 'word' }
    }
  }
  if (
    nonDoiUrlEntry !== null
    && ANY_URL_RE.test(sourceText)
    && !DOI_URL_RE.test(sourceText)
  ) {
    return {
      excluded: true,
      reason: nonDoiUrlEntry.reason || reasons.nonDoiUrl,
      kind: 'non-doi-url',
    }
  }
  if (override === false) {
    return { excluded: true, reason: reasons.userDisabled, kind: 'user' }
  }
  return { excluded: false }
}
