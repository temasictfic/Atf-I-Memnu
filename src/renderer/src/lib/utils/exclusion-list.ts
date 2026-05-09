export interface ExclusionEntry {
  // Lowercased substring to match against the source's reference text, OR
  // an `@`-prefixed directive (e.g. `@non-doi-url`) that activates a
  // hard-coded rule. Directives keep their original casing for the
  // dispatch in computeExclusion; substring entries are lowercased.
  word: string
  reason: string
  /** Set when the entry is a directive rather than a literal word match. */
  kind?: 'non-doi-url'
}

const DIRECTIVE_NON_DOI_URL = '@non-doi-url'

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
    if (word.toLowerCase() === DIRECTIVE_NON_DOI_URL) {
      out.push({ word: DIRECTIVE_NON_DOI_URL, reason, kind: 'non-doi-url' })
    } else {
      out.push({ word: word.toLowerCase(), reason })
    }
  }
  return out
}
