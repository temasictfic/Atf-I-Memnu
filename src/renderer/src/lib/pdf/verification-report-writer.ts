// Generates a from-scratch PDF report of verification results using pdf-lib.
//
// Each source is rendered inside a bordered box:
//   ┌──────────────────────────────────────┐
//   │ [N] raw source text that wraps    │
//   │     across multiple lines …          │
//   ├──────────────────────────────────────┤
//   │ title:87%  Citation  !authors,!year  │
//   │ ┌─ best match card ────────────────┐ │
//   │ │ title / authors / journal        │ │
//   │ │ year  DOI  |  db  score          │ │
//   │ │ https://url.underlined           │ │
//   │ └──────────────────────────────────┘ │
//   └──────────────────────────────────────┘

import { PDFDocument, PDFName, PDFString, PDFArray, PDFNumber, PDFDict, rgb, type PDFFont, type PDFPage, type RGB } from 'pdf-lib'
import fontkit from '@pdf-lib/fontkit'
import { STATUS_RGB, DECISION_RGB } from '../constants/colors'
import { dbScoreRgbTuple, verifyStatusRgbTuple } from '../utils/status-helpers'
// @ts-expect-error Vite ?url import returns a string
import regularFontUrl from 'pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf?url'
// @ts-expect-error Vite ?url import returns a string
import boldFontUrl from 'pdfjs-dist/standard_fonts/LiberationSans-Bold.ttf?url'

let cachedRegular: Uint8Array | null = null
let cachedBold: Uint8Array | null = null

async function loadFontBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Failed to load font from ${url}: ${res.status}`)
  return new Uint8Array(await res.arrayBuffer())
}

async function getFontBytes(): Promise<{ regular: Uint8Array; bold: Uint8Array }> {
  if (!cachedRegular) cachedRegular = await loadFontBytes(regularFontUrl as string)
  if (!cachedBold) cachedBold = await loadFontBytes(boldFontUrl as string)
  return { regular: cachedRegular, bold: cachedBold }
}

// A4
const PAGE_W = 595.28
const PAGE_H = 841.89
const MARGIN_L = 50
const MARGIN_R = 50
const MARGIN_T = 50
const MARGIN_B = 50
const CONTENT_W = PAGE_W - MARGIN_L - MARGIN_R

// Outer ref box
const BOX_PAD = 8
const BOX_INNER_W = CONTENT_W - BOX_PAD * 2

// Inner best-match card — flush with box content left edge
const CARD_PAD = 7
const CARD_W = BOX_INNER_W
const CARD_INNER_W = CARD_W - CARD_PAD * 2

const TITLE_SIZE = 16
const SUBTITLE_SIZE = 12
const BODY_SIZE = 10
const SMALL_SIZE = 9
const TAG_SIZE = 8
const TINY_SIZE = 7.5
const LH = 1.4

const tup = (t: readonly [number, number, number]): RGB => rgb(t[0], t[1], t[2])

const COLOR_HIGH: RGB         = tup(STATUS_RGB.high)
const COLOR_MEDIUM: RGB       = tup(STATUS_RGB.medium)
const COLOR_LOW: RGB          = tup(STATUS_RGB.low)
const COLOR_TEXT: RGB         = rgb(0.1, 0.1, 0.1)
const COLOR_MUTED: RGB        = rgb(0.47, 0.44, 0.40)
const COLOR_DARK: RGB         = rgb(0.267, 0.251, 0.235)
const COLOR_SOURCE: RGB       = rgb(0.341, 0.325, 0.310)
const COLOR_LINK: RGB         = rgb(0.161, 0.404, 0.749)  // #2967bf (DOI + URL)
const COLOR_DB_TEXT: RGB      = rgb(0.851, 0.467, 0.024)  // #d97706 (db badge)
const COLOR_BORDER: RGB       = rgb(0.82, 0.82, 0.82)
const COLOR_CARD_BORDER: RGB  = rgb(0.906, 0.898, 0.890)
const COLOR_CARD_BG: RGB      = rgb(0.980, 0.980, 0.978)
const COLOR_DB_BG: RGB        = rgb(0.996, 0.953, 0.780)
const COLOR_TEAL: RGB         = rgb(0.0, 0.588, 0.533)
// Decision-tag palette (Valid / Citation / Fabricated) — sourced from constants/colors.ts.
const COLOR_VALID_BORDER: RGB      = tup(DECISION_RGB.validBorder)
const COLOR_VALID_TEXT: RGB        = tup(DECISION_RGB.validText)
const COLOR_CITATION_BORDER: RGB   = tup(DECISION_RGB.citationBorder)
const COLOR_CITATION_TEXT: RGB     = tup(DECISION_RGB.citationText)
const COLOR_FABRICATED_BORDER: RGB = tup(DECISION_RGB.fabricatedBorder)
const COLOR_FABRICATED_TEXT: RGB   = tup(DECISION_RGB.fabricatedText)

const statusColor = (s: string): RGB => tup(verifyStatusRgbTuple(s))
const dbScoreColor = (s: number): RGB => tup(dbScoreRgbTuple(s))

// --- Public interfaces ---

export interface ReportBestMatch {
  title: string; authors: string[]; year?: number; journal?: string
  doi?: string; url?: string; database: string; score: number
  titleSimilarity: number; authorMatch: number; yearMatch: number
  // Bibliographic extras — populated when the source database returns them.
  // Rendered as a compact "Bibliographic details" block below the URL.
  volume?: string | null; issue?: string | null; pages?: string | null
  publisher?: string; editor?: string[]; documentType?: string
  language?: string; issn?: string[]; isbn?: string[]
}
export interface ReportSource {
  refNumber: number; text: string; status: string
  problemTags: string[]; bestMatch?: ReportBestMatch
  decisionTag?: 'valid' | 'citation' | 'fabricated'
  decisionTagOverride?: 'valid' | 'citation' | 'fabricated' | null
  tagOverrides?: Record<string, boolean>
  scholarUrl?: string; googleUrl?: string
}
export interface ReportData {
  pdfName: string
  summary: { high: number; medium: number; low: number; total: number; valid?: number; citation?: number; fabricated?: number }
  sources: ReportSource[]
  labels: {
    header: string; high: string; medium: string; low: string
    problems: string; noMatch: string
    sourcesLabel: string
    titleTag: string; validTag: string; citationTag: string; fabricatedTag: string
    tagLabel: (tag: string) => string
    bibliographic: string
    volume: string; issue: string; pages: string; publisher: string
    editor: string; documentType: string; language: string
    issn: string; isbn: string
  }
  // When false, the "Bibliographic details" block under each best-match card
  // is omitted from the PDF. Default true.
  includeBibliographic?: boolean
}

interface ExtraField { key: string; label: string; value: string }

function buildExtras(m: ReportBestMatch, labels: ReportData['labels']): ExtraField[] {
  const out: ExtraField[] = []
  if (m.volume) out.push({ key: 'volume', label: labels.volume, value: m.volume })
  if (m.issue) out.push({ key: 'issue', label: labels.issue, value: m.issue })
  if (m.pages) out.push({ key: 'pages', label: labels.pages, value: m.pages })
  if (m.publisher) out.push({ key: 'publisher', label: labels.publisher, value: m.publisher })
  if (m.editor && m.editor.length > 0) out.push({ key: 'editor', label: labels.editor, value: m.editor.join(', ') })
  if (m.documentType) out.push({ key: 'documentType', label: labels.documentType, value: m.documentType })
  if (m.language) out.push({ key: 'language', label: labels.language, value: m.language })
  if (m.issn && m.issn.length > 0) out.push({ key: 'issn', label: labels.issn, value: m.issn.join(', ') })
  if (m.isbn && m.isbn.length > 0) out.push({ key: 'isbn', label: labels.isbn, value: m.isbn.join(', ') })
  return out
}

function effectiveDecision(src: ReportSource): 'valid' | 'citation' | 'fabricated' {
  if (src.decisionTagOverride) return src.decisionTagOverride
  if (!src.bestMatch) return 'fabricated'
  // Mirror classifyDecisionFromTags in tagState.ts — compute pill live from
  // the current chip states so export matches what the user sees on screen.
  const authorsOn = effectiveTagOnPdf(src, 'authors')
  const yearOn    = effectiveTagOnPdf(src, 'year')
  const titleOn   = effectiveTagOnPdf(src, 'title')
  const journalOn = effectiveTagOnPdf(src, 'journal')
  const doiOn     = effectiveTagOnPdf(src, 'doi/arXiv')
  const authorMatches = !authorsOn, yearMatches = !yearOn, titleMatches = !titleOn
  const journalMatches = !journalOn, doiMatches = !doiOn
  if (authorMatches && yearMatches && titleMatches && journalMatches) return 'valid'
  if (titleMatches || (authorMatches && (yearMatches || journalMatches || doiMatches))) return 'citation'
  return 'fabricated'
}

// --- Helpers ---

function wrapText(text: string, font: PDFFont, sz: number, maxW: number): string[] {
  const lines: string[] = []
  for (const para of text.split('\n')) {
    const words = para.split(/\s+/).filter(Boolean)
    if (!words.length) { lines.push(''); continue }
    let cur = words[0]
    for (let i = 1; i < words.length; i++) {
      const t = cur + ' ' + words[i]
      if (font.widthOfTextAtSize(t, sz) <= maxW) cur = t
      else { lines.push(cur); cur = words[i] }
    }
    lines.push(cur)
  }
  return lines
}

/** Truncate a single-line string with an ellipsis so it fits within maxW. */
function truncateToWidth(text: string, font: PDFFont, sz: number, maxW: number): string {
  if (font.widthOfTextAtSize(text, sz) <= maxW) return text
  const ellipsis = '…'
  let lo = 0, hi = text.length
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2)
    if (font.widthOfTextAtSize(text.slice(0, mid) + ellipsis, sz) <= maxW) lo = mid
    else hi = mid - 1
  }
  return text.slice(0, lo) + ellipsis
}

function san(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
}

// --- PageWriter ---

class PW {
  private doc: PDFDocument
  pg: PDFPage
  y: number
  rf: PDFFont
  bf: PDFFont

  constructor(doc: PDFDocument, rf: PDFFont, bf: PDFFont) {
    this.doc = doc; this.rf = rf; this.bf = bf
    this.pg = doc.addPage([PAGE_W, PAGE_H])
    this.y = PAGE_H - MARGIN_T
  }

  newPage() { this.pg = this.doc.addPage([PAGE_W, PAGE_H]); this.y = PAGE_H - MARGIN_T }
  ensure(h: number) { if (this.y - h < MARGIN_B) this.newPage() }

  text(s: string, x: number, sz: number, font: PDFFont, color: RGB) {
    const lh = sz * LH
    this.ensure(lh)
    this.pg.drawText(san(s), { x, y: this.y - sz, size: sz, font, color })
    this.y -= lh
  }

  skip(n: number) { this.y -= n }

  rect(x: number, y: number, w: number, h: number, opts: { fill?: RGB; border?: RGB; bw?: number }) {
    if (opts.fill) this.pg.drawRectangle({ x, y, width: w, height: h, color: opts.fill })
    if (opts.border) this.pg.drawRectangle({ x, y, width: w, height: h, borderColor: opts.border, borderWidth: opts.bw ?? 0.75 })
  }

  /** Add a clickable URI link annotation over a text region. */
  addLink(url: string, x: number, y: number, w: number, h: number) {
    const ctx = this.doc.context

    // Build the /A (action) dictionary manually with proper PDF types
    const actionDict = PDFDict.withContext(ctx)
    actionDict.set(PDFName.of('Type'), PDFName.of('Action'))
    actionDict.set(PDFName.of('S'), PDFName.of('URI'))
    actionDict.set(PDFName.of('URI'), PDFString.of(url))

    const rect = PDFArray.withContext(ctx)
    rect.push(PDFNumber.of(x))
    rect.push(PDFNumber.of(y))
    rect.push(PDFNumber.of(x + w))
    rect.push(PDFNumber.of(y + h))

    const border = PDFArray.withContext(ctx)
    border.push(PDFNumber.of(0))
    border.push(PDFNumber.of(0))
    border.push(PDFNumber.of(0))

    const annotDict = PDFDict.withContext(ctx)
    annotDict.set(PDFName.of('Type'), PDFName.of('Annot'))
    annotDict.set(PDFName.of('Subtype'), PDFName.of('Link'))
    annotDict.set(PDFName.of('Rect'), rect)
    annotDict.set(PDFName.of('Border'), border)
    annotDict.set(PDFName.of('A'), actionDict)

    const ref = ctx.register(annotDict)
    const existing = this.pg.node.Annots()
    if (existing) existing.push(ref)
    else this.pg.node.set(PDFName.of('Annots'), ctx.obj([ref]))
  }
}

// --- Pre-measure helpers ---

interface TopMeasure {
  badgeW: number; badgeH: number; badgeGap: number
  refLines: string[]  // first line is shorter (badge takes space), rest full-width
  height: number
}

function measureTop(src: ReportSource, rf: PDFFont, bf: PDFFont): TopMeasure {
  const refLabel = san(`[${src.refNumber}]`)
  const badgeW = bf.widthOfTextAtSize(refLabel, BODY_SIZE)
  const badgeH = BODY_SIZE * LH  // just text height, no padding
  const badgeGap = 6

  // Both first and subsequent lines use the indented width so wrapped text
  // stays aligned with the first letter rather than flowing back under the
  // [N] badge.
  const textW = BOX_INNER_W - badgeW - badgeGap
  const refLines = src.text
    ? wrapText(san(src.text), rf, SMALL_SIZE, textW)
    : []

  const firstRowH = Math.max(badgeH, SMALL_SIZE * LH)
  const restH = refLines.length > 1 ? (refLines.length - 1) * SMALL_SIZE * LH : 0

  return { badgeW, badgeH, badgeGap, refLines, height: firstRowH + restH }
}

interface TagItem { text: string; color: RGB; width: number; align?: 'right' }

type PdfTagKey = 'authors' | 'year' | 'title' | 'journal' | 'doi/arXiv'
const PDF_TAG_ORDER: PdfTagKey[] = ['authors', 'year', 'title', 'journal', 'doi/arXiv']

function defaultTagOnPdf(src: ReportSource, tag: PdfTagKey): boolean {
  const bm = src.bestMatch
  const probs = src.problemTags ?? []
  switch (tag) {
    case 'authors':  return probs.includes('!authors')   && !!bm
    case 'year':     return probs.includes('!year')      && !!bm
    case 'journal':  return probs.includes('!journal')   && !!bm
    case 'doi/arXiv':return probs.includes('!doi/arXiv') && !!bm
    case 'title':    return probs.includes('!title')     && !!bm
  }
}

function effectiveTagOnPdf(src: ReportSource, tag: PdfTagKey): boolean {
  const ov = src.tagOverrides?.[tag]
  if (ov !== undefined) return ov
  return defaultTagOnPdf(src, tag)
}

function measureTags(src: ReportSource, labels: ReportData['labels'], bf: PDFFont): TagItem[] {
  const tags: TagItem[] = []

  const pushChip = (text: string, onColor: RGB, on: boolean) => {
    const color = on ? onColor : COLOR_MUTED
    tags.push({ text, color, width: bf.widthOfTextAtSize(san(text), TAG_SIZE) })
  }

  const leftChipsStart = tags.length
  for (const tag of PDF_TAG_ORDER) {
    const on = effectiveTagOnPdf(src, tag)
    if (!on) continue
    if (tag === 'title') {
      const pct = src.bestMatch ? Math.round(src.bestMatch.titleSimilarity * 100) : null
      const text = pct != null ? `${labels.titleTag}: ${pct}%` : `${labels.titleTag}: —`
      pushChip(text, COLOR_TEAL, true)
    } else {
      const text = labels.tagLabel(`!${tag}`)
      pushChip(text, COLOR_MEDIUM, true)
    }
  }
  // "Sorunlar: " prefix — only when at least one chip was added.
  if (tags.length > leftChipsStart) {
    const prefix = `${labels.problems}: `
    tags.splice(leftChipsStart, 0, {
      text: prefix,
      color: COLOR_DARK,
      width: bf.widthOfTextAtSize(san(prefix), TAG_SIZE),
    })
  }

  // Decision tag — always rendered (cycles Valid/Citation/Fabricated), override wins.
  const decision = effectiveDecision(src)
  if (decision === 'valid') {
    const t = labels.validTag
    tags.push({ text: t, color: COLOR_VALID_TEXT, width: bf.widthOfTextAtSize(san(t), TAG_SIZE), align: 'right' })
  } else if (decision === 'citation') {
    const t = labels.citationTag
    tags.push({ text: t, color: COLOR_CITATION_TEXT, width: bf.widthOfTextAtSize(san(t), TAG_SIZE), align: 'right' })
  } else {
    const t = labels.fabricatedTag
    tags.push({ text: t, color: COLOR_FABRICATED_TEXT, width: bf.widthOfTextAtSize(san(t), TAG_SIZE), align: 'right' })
  }

  return tags
}

/** Measure the height of the tags row (single line if they fit, or wrapping). */
function tagsRowHeight(tags: TagItem[]): number {
  if (!tags.length) return 0
  const tagLh = TAG_SIZE * LH
  // For simplicity, compute how many rows the tags need
  let x = 0
  let rows = 1
  const gap = 8
  for (let i = 0; i < tags.length; i++) {
    const needed = tags[i].width + (i > 0 ? gap : 0)
    if (x + needed > BOX_INNER_W && x > 0) { rows++; x = tags[i].width }
    else { x += needed }
  }
  return rows * tagLh
}

interface CardMeasure {
  titleLines: string[]; authorLines: string[]; journalLines: string[]
  metaLine: string; urlLine: string; totalHeight: number
  extras: ExtraField[]; extraLines: string[][]; extrasLabel: string
}

function measureCard(m: ReportBestMatch, src: ReportSource, labels: ReportData['labels'], rf: PDFFont, bf: PDFFont, includeBibliographic: boolean): CardMeasure {
  const lh = SMALL_SIZE * LH, tlh = TINY_SIZE * LH
  const titleLines = wrapText(san(m.title), bf, SMALL_SIZE, CARD_INNER_W)
  const authorLines = m.authors.length ? wrapText(san(m.authors.join(', ')), rf, SMALL_SIZE, CARD_INNER_W) : []
  const journalLines = m.journal ? wrapText(san(m.journal), rf, SMALL_SIZE, CARD_INNER_W) : []
  const metaParts: string[] = []
  if (m.year) metaParts.push(`${m.year}`)
  if (m.doi) metaParts.push(`DOI: ${m.doi}`)
  const metaLine = metaParts.join('   ')
  const urlLine = m.url ?? ''

  // Bibliographic extras: each "Label: value" wrapped to fit the card.
  const extras = includeBibliographic ? buildExtras(m, labels) : []
  const extraLines = extras.map(ex => wrapText(san(`${ex.label}: ${ex.value}`), rf, TINY_SIZE, CARD_INNER_W))
  const extrasLabel = extras.length > 0 ? labels.bibliographic : ''

  let h = CARD_PAD
  h += titleLines.length * lh
  if (authorLines.length) h += 2 + authorLines.length * lh
  if (journalLines.length) h += 2 + journalLines.length * lh
  if (metaLine) h += 2 + lh
  h += 3 + lh // db + score
  if (urlLine) h += 2 + tlh
  // Bibliographic details block: small header + one wrapped row per extra.
  if (extras.length > 0) {
    h += 6 + tlh // gap + header
    for (const lines of extraLines) h += lines.length * tlh
  }
  // Google Scholar + Google Search links (side by side, one row)
  if (src.scholarUrl || src.googleUrl) h += tlh
  h += CARD_PAD

  return { titleLines, authorLines, journalLines, metaLine, urlLine, totalHeight: h, extras, extraLines, extrasLabel }
}

function measureBottom(src: ReportSource, labels: ReportData['labels'], rf: PDFFont, bf: PDFFont, includeBibliographic: boolean): { tags: TagItem[]; card: CardMeasure | null; noMatch: boolean; height: number } {
  const tags = measureTags(src, labels, bf)
  const card = src.bestMatch ? measureCard(src.bestMatch, src, labels, rf, bf, includeBibliographic) : null
  const noMatch = !src.bestMatch && src.status === 'low'

  let h = 0
  const th = tagsRowHeight(tags)
  if (th > 0) h += th + 4
  if (card) h += card.totalHeight + 2
  else if (noMatch) h += SMALL_SIZE * LH + 2

  return { tags, card, noMatch, height: h }
}

// --- Main export ---

export async function generateVerificationReport(data: ReportData): Promise<Uint8Array> {
  const { regular, bold } = await getFontBytes()
  const doc = await PDFDocument.create()
  doc.registerFontkit(fontkit)
  const rf = await doc.embedFont(regular, { subset: true })
  const bf = await doc.embedFont(bold, { subset: true })

  const w = new PW(doc, rf, bf)
  const { labels, summary, pdfName } = data
  const includeBibliographic = data.includeBibliographic ?? true

  // --- Page header (multi-line, each line centered) ---
  for (const line of labels.header.split('\n')) {
    const trimmed = san(line.trim())
    if (!trimmed) continue
    const lineW = bf.widthOfTextAtSize(trimmed, TITLE_SIZE)
    const lineX = MARGIN_L + (CONTENT_W - lineW) / 2
    w.text(trimmed, lineX, TITLE_SIZE, bf, COLOR_DARK)
  }
  w.skip(4)
  // Strip .pdf extension from displayed name
  const displayName = pdfName.replace(/\.pdf$/i, '')
  w.text(displayName, MARGIN_L, SUBTITLE_SIZE, rf, COLOR_MUTED)
  w.skip(8)

  // Summary stats on a single row: "222 kaynak   ● Bulundu: 5   ● Sorunlu: 64   ● Bulunamadı: 153"
  {
    const totalLabel = `${summary.total} ${labels.sourcesLabel}`
    let sx = MARGIN_L
    const sy = w.y - BODY_SIZE
    w.pg.drawText(san(totalLabel), { x: sx, y: sy, size: BODY_SIZE, font: bf, color: COLOR_TEXT })
    sx += bf.widthOfTextAtSize(san(totalLabel), BODY_SIZE) + 12

    const summaryParts: { l: string; c: number; clr: RGB }[] = [
      { l: labels.high, c: summary.high, clr: COLOR_HIGH },
      { l: labels.medium, c: summary.medium, clr: COLOR_MEDIUM },
      { l: labels.low, c: summary.low, clr: COLOR_LOW },
    ]
    if (summary.valid != null) {
      summaryParts.push({ l: labels.validTag, c: summary.valid, clr: COLOR_VALID_BORDER })
    }
    if (summary.citation != null) {
      summaryParts.push({ l: labels.citationTag, c: summary.citation, clr: COLOR_CITATION_BORDER })
    }
    if (summary.fabricated != null) {
      summaryParts.push({ l: labels.fabricatedTag, c: summary.fabricated, clr: COLOR_FABRICATED_BORDER })
    }
    for (const p of summaryParts) {
      w.pg.drawCircle({ x: sx + 3, y: sy + BODY_SIZE * 0.35, size: 3, color: p.clr })
      sx += 10
      const partText = `${p.l}: ${p.c}`
      w.pg.drawText(san(partText), { x: sx, y: sy, size: BODY_SIZE, font: rf, color: COLOR_TEXT })
      sx += rf.widthOfTextAtSize(san(partText), BODY_SIZE) + 12
    }
    w.skip(BODY_SIZE * LH)
  }
  w.skip(4)
  w.pg.drawLine({ start: { x: MARGIN_L, y: w.y }, end: { x: PAGE_W - MARGIN_R, y: w.y }, thickness: 0.5, color: COLOR_BORDER })
  w.skip(10)

  // --- Sources --- preserve caller-provided order (matches middle-pane sort).
  const sorted = data.sources

  for (const src of sorted) {
    const top = measureTop(src, rf, bf)
    const bot = measureBottom(src, labels, rf, bf, includeBibliographic)
    const totalBoxH = BOX_PAD + top.height + 4 + 0.5 + 4 + bot.height + BOX_PAD
    const boxX = MARGIN_L
    const boxW = CONTENT_W

    // Never split a source box across pages
    if (w.y - totalBoxH < MARGIN_B) w.newPage()

    const boxTopY = w.y

    // Outer border — driven by the (possibly overridden) decision classification.
    const decision = effectiveDecision(src)
    let borderColor: RGB
    let borderWidth: number
    if (decision === 'citation') {
      borderColor = COLOR_CITATION_BORDER; borderWidth = 1.2
    } else if (decision === 'fabricated') {
      borderColor = COLOR_FABRICATED_BORDER; borderWidth = 1.2
    } else if (decision === 'valid') {
      borderColor = COLOR_VALID_BORDER; borderWidth = 1.0
    } else {
      borderColor = COLOR_BORDER; borderWidth = 0.75
    }
    w.rect(boxX, boxTopY - totalBoxH, boxW, totalBoxH, { border: borderColor, bw: borderWidth })

    const cx = boxX + BOX_PAD
    w.skip(BOX_PAD)

    // === TOP SECTION: [N] colored text + ref text on same row ===
    {
      const refLabel = san(`[${src.refNumber}]`)
      const baseY = w.y - BODY_SIZE

      // Colored ref number
      w.pg.drawText(refLabel, { x: cx, y: baseY, size: BODY_SIZE, font: bf, color: statusColor(src.status) })

      // First line of ref text on same baseline
      const textX = cx + top.badgeW + top.badgeGap
      if (top.refLines.length > 0) {
        w.pg.drawText(san(top.refLines[0]), { x: textX, y: baseY, size: SMALL_SIZE, font: rf, color: COLOR_TEXT })
      }

      // Advance past first row
      w.skip(BODY_SIZE * LH)

      // Remaining lines indented so they line up with the first letter
      // of the source text (past the [N] badge) instead of sliding
      // back under the badge.
      for (let i = 1; i < top.refLines.length; i++) {
        w.text(top.refLines[i], textX, SMALL_SIZE, rf, COLOR_TEXT)
      }
    }

    // Advance to divider
    const topDrawn = boxTopY - w.y - BOX_PAD
    if (topDrawn < top.height) w.skip(top.height - topDrawn)
    w.skip(4)

    // Divider line
    w.pg.drawLine({
      start: { x: boxX + 1, y: w.y },
      end: { x: boxX + boxW - 1, y: w.y },
      thickness: 0.5, color: COLOR_BORDER,
    })
    w.skip(4)

    // === BOTTOM SECTION: tags (inline) + best match card ===

    // Tags: left-aligned tags on the left, right-aligned tag at right end, same row
    if (bot.tags.length) {
      const tagGap = 8
      const tagLh = TAG_SIZE * LH
      const leftTags = bot.tags.filter(t => t.align !== 'right')
      const rightTag = bot.tags.find(t => t.align === 'right')
      const baseY = w.y - TAG_SIZE

      // Draw left-aligned tags
      let tx = cx
      for (let i = 0; i < leftTags.length; i++) {
        const tag = leftTags[i]
        const needed = tag.width + (tx > cx ? tagGap : 0)
        if (tx + needed > cx + BOX_INNER_W && tx > cx) {
          w.skip(tagLh)
          tx = cx
        }
        if (tx > cx) tx += tagGap
        w.pg.drawText(san(tag.text), { x: tx, y: w.y - TAG_SIZE, size: TAG_SIZE, font: bf, color: tag.color })
        tx += tag.width
      }

      // Draw right-aligned tag at the right end of the row
      if (rightTag) {
        const rx = cx + BOX_INNER_W - rightTag.width
        w.pg.drawText(san(rightTag.text), { x: rx, y: baseY, size: TAG_SIZE, font: bf, color: rightTag.color })
      }

      w.skip(tagLh + 4)
    }

    // Best match card — left-aligned with cx (same as badge)
    if (bot.card && src.bestMatch) {
      const m = src.bestMatch
      const card = bot.card
      const cardX = cx
      const cardTopY = w.y

      // Card bg + border
      w.rect(cardX, cardTopY - card.totalHeight, CARD_W, card.totalHeight, {
        fill: COLOR_CARD_BG, border: COLOR_CARD_BORDER,
      })

      const ccx = cardX + CARD_PAD
      w.skip(CARD_PAD)

      // Title
      for (const line of card.titleLines)
        w.text(line, ccx, SMALL_SIZE, bf, COLOR_DARK)

      // Authors
      if (card.authorLines.length) {
        w.skip(2)
        for (const line of card.authorLines) w.text(line, ccx, SMALL_SIZE, rf, COLOR_MUTED)
      }

      // Journal
      if (card.journalLines.length) {
        w.skip(2)
        for (const line of card.journalLines) w.text(line, ccx, SMALL_SIZE, rf, COLOR_SOURCE)
      }

      // Year | DOI
      if (card.metaLine) {
        w.skip(2)
        if (m.doi) {
          const yearPart = m.year ? `${m.year}   ` : ''
          const doiPart = `DOI: ${m.doi}`
          const yw = yearPart ? rf.widthOfTextAtSize(san(yearPart), SMALL_SIZE) : 0
          if (yearPart) w.pg.drawText(san(yearPart), { x: ccx, y: w.y - SMALL_SIZE, size: SMALL_SIZE, font: rf, color: COLOR_MUTED })
          w.pg.drawText(san(doiPart), { x: ccx + yw, y: w.y - SMALL_SIZE, size: SMALL_SIZE, font: rf, color: COLOR_LINK })
          w.skip(SMALL_SIZE * LH)
        } else {
          w.text(card.metaLine, ccx, SMALL_SIZE, rf, COLOR_MUTED)
        }
      }

      // Database badge + score
      w.skip(3)
      const dbLabel = san(m.database)
      const dbW = bf.widthOfTextAtSize(dbLabel, TINY_SIZE) + 8
      const dbBY = w.y - SMALL_SIZE * LH + 2
      w.rect(ccx, dbBY, dbW, SMALL_SIZE * LH - 1, { fill: COLOR_DB_BG })
      w.pg.drawText(dbLabel, { x: ccx + 4, y: dbBY + 3, size: TINY_SIZE, font: bf, color: COLOR_DB_TEXT })
      w.pg.drawText(san(`${Math.round(m.score * 100)}%`), {
        x: ccx + dbW + 6, y: dbBY + 3, size: SMALL_SIZE, font: bf, color: dbScoreColor(m.score),
      })
      w.skip(SMALL_SIZE * LH)

      // URL (underlined, clickable) — truncated to a single line
      if (m.url) {
        w.skip(2)
        const displayUrl = truncateToWidth(san(m.url), rf, TINY_SIZE, CARD_INNER_W)
        const uy = w.y - TINY_SIZE
        w.pg.drawText(displayUrl, { x: ccx, y: uy, size: TINY_SIZE, font: rf, color: COLOR_LINK })
        const uw = rf.widthOfTextAtSize(displayUrl, TINY_SIZE)
        w.pg.drawLine({ start: { x: ccx, y: uy - 1 }, end: { x: ccx + uw, y: uy - 1 }, thickness: 0.4, color: COLOR_LINK })
        w.skip(TINY_SIZE * LH)
        w.addLink(m.url, ccx, w.y, uw, TINY_SIZE * LH)
      }

      // Bibliographic details — compact second block listing every populated
      // extra field (volume, issue, pages, publisher, editor, document type,
      // language, ISSN, ISBN). Always rendered when at least one extra is
      // present; missing fields are skipped.
      if (card.extras.length > 0) {
        w.skip(6)
        w.text(card.extrasLabel, ccx, TINY_SIZE, bf, COLOR_MUTED)
        for (const lines of card.extraLines) {
          for (const line of lines) {
            w.text(line, ccx, TINY_SIZE, rf, COLOR_SOURCE)
          }
        }
      }

      // Google Scholar + Google Search links side by side (clickable)
      {
        const gLinks = [
          { label: 'Google Scholar', url: src.scholarUrl },
          { label: 'Google Search', url: src.googleUrl },
        ].filter(l => l.url)
        if (gLinks.length) {
          const uy = w.y - TINY_SIZE
          const gap = 12
          let gx = ccx
          for (const link of gLinks) {
            const lt = san(link.label)
            const lw = bf.widthOfTextAtSize(lt, TINY_SIZE)
            w.pg.drawText(lt, { x: gx, y: uy, size: TINY_SIZE, font: bf, color: COLOR_LINK })
            w.pg.drawLine({ start: { x: gx, y: uy - 1 }, end: { x: gx + lw, y: uy - 1 }, thickness: 0.4, color: COLOR_LINK })
            w.addLink(link.url!, gx, uy - 1, lw, TINY_SIZE + 2)
            gx += lw + gap
          }
          w.skip(TINY_SIZE * LH)
        }
      }

      // Ensure cursor past card bottom
      const cardDrawn = cardTopY - w.y
      if (cardDrawn < card.totalHeight) w.skip(card.totalHeight - cardDrawn)
    } else if (bot.noMatch) {
      w.text(labels.noMatch, cx, SMALL_SIZE, rf, COLOR_LOW)
    }

    // Ensure cursor past box bottom
    const boxDrawn = boxTopY - w.y
    if (boxDrawn < totalBoxH) w.skip(totalBoxH - boxDrawn)

    w.skip(8)
  }

  return doc.save()
}
