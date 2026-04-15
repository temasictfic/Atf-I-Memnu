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
// Load the exact same TTFs that annotation-writer embeds into the
// exported PDF. The `?url` asset import gives us a URL we can feed into
// the FontFace API so canvas.measureText renders with the very font the
// exporter draws with — no Arial/Liberation metric drift to compensate
// for.
// @ts-expect-error Vite ?url import returns a string
import regularFontUrl from 'pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf?url'
// @ts-expect-error Vite ?url import returns a string
import boldFontUrl from 'pdfjs-dist/standard_fonts/LiberationSans-Bold.ttf?url'

// Whitespace padding between the reference and the callout, in SCALE pixels.
const CALLOUT_GAP_PX = 6
// Horizontal padding inside the callout box — matches annotation-writer.
const CALLOUT_INNER_PAD_PX = 4 * SCALE
// Private family name we register the TTFs under so the canvas can
// reference them without colliding with any OS-installed Liberation.
const MEASURE_FONT_FAMILY = '__atfi_liberation_measure__'
// Once-per-session font load. Kicked off at module import so the first
// auto-annotate click (after the app has been open for a moment) doesn't
// need to wait.
const measureFontReady = loadMeasureFonts()

interface GenerateArgs {
  pdfId: string
  pdfName: string
  sources: SourceRectangle[]
  resultsBySourceId: Record<string, VerificationResult>
  pageHeightFor: (pageNum: number) => number
  pageWidthFor: (pageNum: number) => number
}

interface GenerateStats {
  highlightsAdded: number
  calloutsAdded: number
}

export async function generateAutoNotesForPdf({
  pdfId,
  pdfName,
  sources,
  resultsBySourceId,
  pageHeightFor,
  pageWidthFor,
}: GenerateArgs): Promise<GenerateStats> {
  // Wait for Liberation Sans to be available to the canvas measurer
  // before we size any callouts. If loading fails we fall back to the
  // generic sans-serif metric (with a small safety margin baked in
  // below); otherwise widths match the exporter exactly.
  await measureFontReady.catch(() => undefined)

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
    const textWidthPx = measureTextWidthScalePx(
      calloutText,
      calloutFontSize,
      calloutBold,
    )
    // Add one hair of rounding headroom so a floating-point tie doesn't
    // push the exporter's <=-check on the wrong side. One SCALE pixel
    // (~0.48 pt) is imperceptible visually but eliminates the edge case.
    const calloutWidthPx = textWidthPx + CALLOUT_INNER_PAD_PX * 2 + 1

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

  // Title callout: PDF file name, centered above the header at the top of
  // the first page. Uses the same callout palette as the status callouts,
  // bolded and sized one step up so it reads as a title. Skipped when no
  // status annotations were produced — matches the "nothing to do" alert.
  const titleName = stripPdfExtension(pdfName).trim()
  if (titleName.length > 0 && (highlightsAdded > 0 || calloutsAdded > 0)) {
    const titlePageNum = 0
    const titlePageH = pageHeightFor(titlePageNum)
    const titlePageW = pageWidthFor(titlePageNum)
    if (titlePageH > 0 && titlePageW > 0) {
      const titleFontSize = calloutFontSize + 1
      const titleLineHeight = titleFontSize * 1.2 * SCALE
      const titleHeightPx = titleLineHeight + CALLOUT_INNER_PAD_PX * 2
      const titleTextWidthPx = measureTextWidthScalePx(
        titleName,
        titleFontSize,
        true,
      )
      const maxTitleWidth = Math.max(titlePageW - 20 * SCALE, 0)
      const titleWidthPx = Math.min(
        titleTextWidthPx + CALLOUT_INNER_PAD_PX * 2 + 1,
        maxTitleWidth > 0 ? maxTitleWidth : titlePageW,
      )
      const titleTopMarginPx = 8 * SCALE
      const titleX0 = Math.max((titlePageW - titleWidthPx) / 2, 0)
      const titleRect = {
        x0: titleX0,
        y0: titleTopMarginPx,
        x1: titleX0 + titleWidthPx,
        y1: titleTopMarginPx + titleHeightPx,
      }
      addNote({
        pdfId,
        pageNum: titlePageNum,
        kind: 'callout',
        bbox: titleRect,
        text: titleName,
        color: '#ffffff',
        textColor: calloutTextColor,
        fontSize: titleFontSize,
        bold: true,
        autoForSourceId: `__pdf_title__${pdfId}`,
      })
      calloutsAdded++
    }
  }

  return { highlightsAdded, calloutsAdded }
}

function stripPdfExtension(name: string): string {
  return name.replace(/\.pdf$/i, '')
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

// Register the same Liberation Sans TTFs the exporter uses with the
// browser's font system so canvas.measureText can see them. Runs once,
// on module import. Returns a promise that resolves when both weights
// are ready (or rejects if the TTF fetch fails — callers fall back to
// generic sans-serif in that case).
async function loadMeasureFonts(): Promise<void> {
  if (typeof document === 'undefined' || typeof FontFace === 'undefined') return
  const regular = new FontFace(
    MEASURE_FONT_FAMILY,
    `url(${regularFontUrl as string})`,
    { weight: '400', style: 'normal' },
  )
  const bold = new FontFace(
    MEASURE_FONT_FAMILY,
    `url(${boldFontUrl as string})`,
    { weight: '700', style: 'normal' },
  )
  const [regLoaded, boldLoaded] = await Promise.all([regular.load(), bold.load()])
  document.fonts.add(regLoaded)
  document.fonts.add(boldLoaded)
  // Give the browser one tick to commit the registration so the first
  // canvas.font assignment actually picks up the new family.
  await document.fonts.ready
}

// Width of a single-line text at the given font size (and optional bold),
// expressed in SCALE pixels — the same coordinate space as note bboxes.
// One SCALE pixel equals one CSS pixel in the rendered DOM, so setting
// the canvas font to `${fontSizePt * SCALE}px` returns measurements
// directly in our space. We render with the private Liberation Sans
// family loaded by `loadMeasureFonts`, falling back to generic sans if
// that load failed.
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
  ctx.font = `${weight} ${fontSizePt * SCALE}px '${MEASURE_FONT_FAMILY}', sans-serif`
  // pdf-lib's widthOfTextAtSize sums raw glyph advances with no kerning
  // applied. Canvas applies kerning by default, which returns a slightly
  // SMALLER width — enough to convince our compact box to fit when the
  // exporter then computes a wider (kerning-free) width and wraps the
  // last word. Disabling canvas kerning aligns the two measurements.
  const anyCtx = ctx as unknown as { fontKerning?: string }
  anyCtx.fontKerning = 'none'
  return ctx.measureText(text).width
}
