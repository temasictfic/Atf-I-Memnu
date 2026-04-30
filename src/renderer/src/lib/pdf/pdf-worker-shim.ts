// Module worker entry that polyfills Math.sumPrecise (proposal-stage in V8 <13.0,
// not present in Electron 41's bundled Chromium) before loading the pdfjs worker.
// pdfjs-dist 5.x calls Math.sumPrecise during font translation; without this,
// every font falls back to an "error font" and degrades text extraction.

if (typeof (Math as { sumPrecise?: unknown }).sumPrecise !== 'function') {
  // Neumaier compensated summation — close enough to the proposal's semantics
  // for pdfjs's use cases (glyph widths, table column sums, byte counts).
  ;(Math as unknown as { sumPrecise: (iter: Iterable<number>) => number }).sumPrecise = (
    iter: Iterable<number>
  ): number => {
    let sum = 0
    let c = 0
    for (const v of iter) {
      const n = +v
      const t = sum + n
      c += Math.abs(sum) >= Math.abs(n) ? sum - t + n : n - t + sum
      sum = t
    }
    return sum + c
  }
}

// @ts-expect-error pdfjs-dist ships no types for the raw worker entry
await import('pdfjs-dist/build/pdf.worker.min.mjs')

export {}
