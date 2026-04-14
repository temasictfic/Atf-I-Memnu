// Build highlight + callout notes automatically from verification results.
//
// For every SourceRectangle whose verification status is `not_found` or
// `problematic`, we drop:
//   1. A yellow highlight over each of its bboxes (primary + continuation
//      bboxes for multi-page refs).
//   2. A compact callout directly below the FIRST bbox of the reference —
//      sized to its text width (plus padding), ideal single-line height.
//      Consecutive auto-targeted refs alternate between left-aligned and
//      right-aligned under the reference so they have less chance of
//      stacking on top of each other horizontally.
//
// The action is idempotent: every previously auto-generated note is
// stripped before emitting the new batch.

import type { SourceRectangle, VerificationResult, BoundingBox } from '../api/types'
import {
  addNote,
  removeAutoNotesForPdf,
  useNotesStore,
  AUTO_CALLOUT_TEXT_NOT_FOUND,
  AUTO_CALLOUT_TEXT_PROBLEMATIC,
} from '../stores/notes-store'
import { SCALE } from '../pdf/types'

// Whitespace padding between the reference and the callout, in SCALE pixels.
const CALLOUT_GAP_PX = 6
// Horizontal padding inside the callout box — matches annotation-writer.
const CALLOUT_INNER_PAD_PX = 4 * SCALE
// Safety multiplier on the measured text width. Canvas measureText runs
// against the OS Arial/Helvetica, but the exported PDF is drawn with
// Liberation Sans — the metrics are close but not identical, so without
// headroom the last word can wrap onto a second line that the compact
// single-line box would clip. 1.20 (20% extra) is enough to cover the
// drift we've seen for Turkish glyphs (ı/ş/ğ/ç), including bold.
const CALLOUT_WIDTH_SAFETY = 1.2

interface GenerateArgs {
  pdfId: string
  sources: SourceRectangle[]
  resultsBySourceId: Record<string, VerificationResult>
  pageHeightFor: (pageNum: number) => number
}

interface GenerateStats {
  highlightsAdded: number
  calloutsAdded: number
}

export function generateAutoNotesForPdf({
  pdfId,
  sources,
  resultsBySourceId,
  pageHeightFor,
}: GenerateArgs): GenerateStats {
  removeAutoNotesForPdf(pdfId)

  // Pull the user's persisted defaults (colors, text color, font size,
  // boldness) from the notes-store so Auto-annotate uses the same palette
  // as manual notes. Changing them in the Notes panel persists the choice
  // for the session.
  const storeState = useNotesStore.getState()
  const highlightColor = storeState.highlightColor
  const calloutColor = storeState.calloutColor
  const calloutTextColor = storeState.calloutTextColor
  const calloutFontSize = storeState.calloutFontSize
  const calloutBold = storeState.calloutBold

  // Compact single-line height (matches annotation-writer metrics). The
  // extra CALLOUT_WIDTH_SAFETY on width keeps text on one line.
  const lineHeightPx = calloutFontSize * 1.2 * SCALE
  const idealCalloutHeightPx = lineHeightPx + CALLOUT_INNER_PAD_PX * 2

  let highlightsAdded = 0
  let calloutsAdded = 0
  // Toggles every time a callout is placed, to alternate side.
  let calloutSide: 'left' | 'right' = 'left'

  for (const source of sources) {
    const result = resultsBySourceId[source.id]
    if (!result) continue
    if (result.status !== 'not_found' && result.status !== 'problematic') continue

    const bboxes: BoundingBox[] =
      source.bboxes && source.bboxes.length > 0 ? source.bboxes : [source.bbox]

    // Highlights — one per bbox so multi-page refs light up fully.
    for (const bb of bboxes) {
      addNote({
        pdfId,
        pageNum: bb.page,
        kind: 'highlight',
        bbox: { x0: bb.x0, y0: bb.y0, x1: bb.x1, y1: bb.y1 },
        text: source.text,
        color: highlightColor,
        autoForSourceId: source.id,
      })
      highlightsAdded++
    }

    // Anchor the callout on the FIRST bbox — if a ref spans two pages,
    // this drops the callout in the whitespace below the first-page part.
    const anchor = bboxes[0]
    const pageH = pageHeightFor(anchor.page)

    const isNotFound = result.status === 'not_found'
    const calloutText = isNotFound
      ? AUTO_CALLOUT_TEXT_NOT_FOUND
      : AUTO_CALLOUT_TEXT_PROBLEMATIC
    const textWidthPx =
      measureTextWidthScalePx(calloutText, calloutFontSize, calloutBold) *
      CALLOUT_WIDTH_SAFETY
    const calloutWidthPx = textWidthPx + CALLOUT_INNER_PAD_PX * 2

    const calloutRect = computeCalloutRectBelow(
      anchor,
      pageH,
      calloutWidthPx,
      idealCalloutHeightPx,
      calloutSide,
    )
    if (!calloutRect) continue
    // Flip side for the next callout regardless of whether this one
    // succeeded — if placement did fail, keep the toggle so visually the
    // alternation pattern still reads as intended.
    calloutSide = calloutSide === 'left' ? 'right' : 'left'

    addNote({
      pdfId,
      pageNum: anchor.page,
      kind: 'callout',
      bbox: calloutRect,
      text: calloutText,
      color: calloutColor,
      textColor: calloutTextColor,
      fontSize: calloutFontSize,
      bold: calloutBold,
      autoForSourceId: source.id,
    })
    calloutsAdded++
  }

  return { highlightsAdded, calloutsAdded }
}

// Place the callout directly below the anchor at the requested compact
// width and ideal single-line height, aligned to either the anchor's
// left or right edge. No collision avoidance — the callout lands where
// it lands. The only clamp is keeping the bottom edge inside the page.
function computeCalloutRectBelow(
  anchor: BoundingBox,
  pageHeightPx: number,
  widthPx: number,
  idealHeightPx: number,
  side: 'left' | 'right',
): { x0: number; y0: number; x1: number; y1: number } | null {
  const y0 = anchor.y1 + CALLOUT_GAP_PX
  if (y0 >= pageHeightPx) return null
  const y1 = Math.min(y0 + idealHeightPx, pageHeightPx)

  let x0: number
  let x1: number
  if (side === 'left') {
    x0 = anchor.x0
    x1 = x0 + widthPx
  } else {
    x1 = anchor.x1
    x0 = x1 - widthPx
  }
  return { x0, y0, x1, y1 }
}

// --- Text measurement --------------------------------------------------

let measureCtx: CanvasRenderingContext2D | null = null
function getMeasureCtx(): CanvasRenderingContext2D | null {
  if (measureCtx) return measureCtx
  if (typeof document === 'undefined') return null
  const c = document.createElement('canvas')
  measureCtx = c.getContext('2d')
  return measureCtx
}

// Width of a single-line text at the given font size (and optional bold),
// expressed in SCALE pixels — the same coordinate space as note bboxes.
// One SCALE pixel equals one CSS pixel in the rendered DOM, so setting the
// canvas font to `${fontSizePt * SCALE}px` returns measurements directly
// in our space.
function measureTextWidthScalePx(
  text: string,
  fontSizePt: number,
  bold = false,
): number {
  const ctx = getMeasureCtx()
  if (!ctx) {
    // Fallback: rough estimate (~0.55 × font size per char).
    return text.length * 0.55 * fontSizePt * SCALE
  }
  const weight = bold ? '700' : '400'
  ctx.font = `${weight} ${fontSizePt * SCALE}px Helvetica, Arial, sans-serif`
  return ctx.measureText(text).width
}
