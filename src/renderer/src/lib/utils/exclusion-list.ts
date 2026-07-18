export interface ExclusionEntry {
  // Lowercased substring to match against the source's reference text, OR
  // an `@`-prefixed directive (e.g. `@non-doi-url`) that activates a
  // hard-coded rule. Directives keep their original casing for the
  // dispatch in computeExclusion; substring entries are lowercased.
  word: string
  reason: string
  /** Set when the entry is a directive rather than a literal word match. */
  kind?: 'non-doi-url' | 'non-doi-domain' | 'year-before'
  /** Normalized hostname for a bare non-DOI URL allowlist entry. */
  domain?: string
  /** Exclusive upper publication-year boundary for a year directive. */
  yearBefore?: number
}

const DIRECTIVE_NON_DOI_URL = '@non-doi-url'
const DIRECTIVE_YEAR_BEFORE = '@year-before'
const BARE_DOMAIN_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i

function bareDomain(value: string): string | null {
  const domain = value.toLowerCase()
  return BARE_DOMAIN_RE.test(domain) ? domain : null
}

export function parseExclusionList(text: string): ExclusionEntry[] {
  const out: ExclusionEntry[] = []
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const sepIdx = line.indexOf('|')
    let word: string
    let reason: string
    if (sepIdx === -1) {
      word = line
      reason = ''
    } else {
      word = line.slice(0, sepIdx).trim()
      reason = line.slice(sepIdx + 1).trim()
    }
    if (!word) continue
    const [directive, argument] = word.toLowerCase().split(/\s+/, 2)
    if (word.toLowerCase() === DIRECTIVE_NON_DOI_URL) {
      out.push({ word: DIRECTIVE_NON_DOI_URL, reason, kind: 'non-doi-url' })
    } else if (directive === DIRECTIVE_YEAR_BEFORE) {
      const yearBefore = Number(argument)
      if (Number.isInteger(yearBefore) && yearBefore >= 1 && yearBefore <= 9999) {
        out.push({ word: directive, reason, kind: 'year-before', yearBefore })
      }
    } else if (word.startsWith('@')) {
      // Directives are opt-in syntax. Ignore unknown or malformed ones
      // rather than accidentally treating them as a literal exclusion word.
      continue
    } else if (sepIdx === -1 && bareDomain(word)) {
      const domain = bareDomain(word)
      // A bare hostname is an allowlist entry, never a text exclusion.
      out.push({ word: domain!, reason: '', kind: 'non-doi-domain', domain: domain! })
    } else {
      out.push({ word: word.toLowerCase(), reason })
    }
  }
  return out
}
