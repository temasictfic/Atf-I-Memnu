import type { TagKey, TrustTag, VerificationResult } from '../api/types'

export const TAG_ORDER: TagKey[] = ['authors', 'year', 'title', 'source', 'doi/arXiv']

export interface TagStateResultLike {
  problem_tags?: string[]
  best_match?: {
    authors?: string[]
    year?: number | null
    journal?: string
    doi?: string | null
  }
  tag_overrides?: Record<string, boolean>
  trust_tag?: TrustTag
  trust_tag_override?: TrustTag | null
}

export function defaultTagOn(result: TagStateResultLike | undefined, tag: TagKey): boolean {
  if (!result) return false
  const bm = result.best_match
  const probs = result.problem_tags ?? []
  // Pure pass-through from the backend's problem_tags. The backend is
  // authoritative: it already fires a tag when the source has the field
  // but the candidate is missing it or disagrees, which is exactly the
  // signal the user needs to see for Künye/Uydurma reasoning.
  switch (tag) {
    case 'authors':  return probs.includes('!authors') && !!bm
    case 'year':     return probs.includes('!year') && !!bm
    case 'source':   return probs.includes('!source') && !!bm
    case 'doi/arXiv':return probs.includes('!doi/arXiv') && !!bm
    case 'title':    return probs.includes('!title') && !!bm
  }
}

export function effectiveTagOn(result: TagStateResultLike | undefined, tag: TagKey): boolean {
  const ov = result?.tag_overrides?.[tag]
  if (ov !== undefined) return ov
  return defaultTagOn(result, tag)
}

export function anyTagOn(result: TagStateResultLike | undefined): boolean {
  return TAG_ORDER.some(t => effectiveTagOn(result, t))
}

/** Classify trust from the currently-effective chip states, using the rule
 *  mirrored from the backend's classify_trust(). A chip OFF means the signal
 *  matches; a chip ON means it disagrees or is missing on one side. */
export function classifyTrustFromTags(result: TagStateResultLike | undefined): TrustTag {
  if (!result || !result.best_match) return 'uydurma'
  const authorsOn = effectiveTagOn(result, 'authors')
  const yearOn    = effectiveTagOn(result, 'year')
  const titleOn   = effectiveTagOn(result, 'title')
  const sourceOn  = effectiveTagOn(result, 'source')
  const doiOn     = effectiveTagOn(result, 'doi/arXiv')

  // OFF = matches
  const authorMatches = !authorsOn
  const yearMatches   = !yearOn
  const titleMatches  = !titleOn
  const sourceMatches = !sourceOn
  const doiMatches    = !doiOn

  if (authorMatches && yearMatches && titleMatches && sourceMatches) return 'clean'
  if (titleMatches || (authorMatches && (yearMatches || sourceMatches || doiMatches))) return 'künye'
  return 'uydurma'
}

export function effectiveTrustTag(result: TagStateResultLike | undefined): TrustTag {
  if (!result) return 'clean'
  // A manual pill cycle (trust_tag_override) always wins. Otherwise the pill
  // reflects the current chip states — so toggling a chip immediately
  // re-classifies the reference.
  if (result.trust_tag_override) return result.trust_tag_override
  return classifyTrustFromTags(result)
}

export type { VerificationResult }
