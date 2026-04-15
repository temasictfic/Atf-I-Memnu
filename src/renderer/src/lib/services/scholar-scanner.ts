/**
 * Google Scholar automated scanner.
 *
 * Uses a hidden Electron <webview> to sequentially search Google Scholar
 * for non-Found references, extract results from the DOM, and send them
 * to the backend for scoring.
 */

import type { ScholarCandidate } from '../api/types'
import { api } from '../api/rest-client'

// --- Types ---

export interface ScholarQueueItem {
  pdfId: string
  sourceId: string
  searchText: string
}

export type ScholarScanStatus = 'idle' | 'scanning' | 'captcha' | 'done' | 'cancelled'

export interface ScholarScanCallbacks {
  onStatusChange: (status: ScholarScanStatus) => void
  onProgress: (current: number, total: number, foundCount: number) => void
  onCaptcha: (url: string) => void
  onCaptchaResolved: () => void  // close overlay + cleanup after CAPTCHA
  onError: (sourceId: string, error: string) => void
  onSourceDone: (sourceId: string, updated: boolean) => void
}

// --- Extraction script injected into the webview ---
// Single async IIFE that polls up to 2500ms for either CAPTCHA markers or
// result items, extracts in the same pass, and short-circuits as soon as
// either is found. This replaces the old pair of separate DETECT+EXTRACT
// scripts and the hardcoded 2500ms post-load sleep — pages that render in
// 200-500ms (most of them) now complete extraction in well under a second
// instead of waiting out the full delay.
const POLL_AND_EXTRACT_SCRIPT = `
(async function() {
  var CAPTCHA_SELECTORS = '#gs_captcha_f, #gs_captcha_ccl, #captcha-form, #recaptcha, iframe[src*="recaptcha"], iframe[src*="captcha"]';
  var RESULT_SELECTORS = ['.gs_r.gs_or.gs_scl', '.gs_r.gs_or', '.gs_ri', '[data-cid]'];

  function detectCaptcha() {
    if (document.querySelector(CAPTCHA_SELECTORS)) return true;
    if (window.location.hostname.indexOf('sorry.google.com') !== -1) return true;
    var title = (document.title || '').toLowerCase();
    if (title.indexOf('sorry') !== -1 || title.indexOf('unusual traffic') !== -1) return true;
    var bodyText = (document.body && document.body.innerText) || '';
    if (bodyText.indexOf('unusual traffic') !== -1 || bodyText.indexOf('not a robot') !== -1) return true;
    return false;
  }

  function findItems() {
    for (var i = 0; i < RESULT_SELECTORS.length; i++) {
      var items = document.querySelectorAll(RESULT_SELECTORS[i]);
      if (items.length) return items;
    }
    return [];
  }

  function extract(items) {
    var results = [];
    for (var i = 0; i < items.length; i++) {
      var el = items[i];
      var titleEl = el.querySelector('.gs_rt a')
        || el.querySelector('h3 a')
        || el.querySelector('a[data-clk]');
      if (!titleEl) continue;
      var rawTitle = titleEl.textContent || '';
      var title = rawTitle.replace(/^\\s*\\[.*?\\]\\s*/, '').trim();
      if (!title) continue;
      var url = titleEl.href || '';
      var metaEl = el.querySelector('.gs_a');
      var metaText = metaEl ? (metaEl.textContent || '') : '';
      var parts = metaText.split(' - ');
      var authorsPart = (parts[0] || '').trim();
      var authors = authorsPart.split(',').map(function(a) { return a.trim(); })
        .filter(function(a) { return a.length > 0 && a !== '\\u2026'; });
      var year = null;
      var yearMatch = metaText.match(/\\b(19|20)\\d{2}\\b/);
      if (yearMatch) year = parseInt(yearMatch[0]);
      var doi = null;
      var links = el.querySelectorAll('a');
      for (var j = 0; j < links.length; j++) {
        var href = links[j].href || '';
        var doiMatch = href.match(/doi\\.org\\/(10\\.\\d{4,}\\/.+?)(?:[?&#]|$)/);
        if (doiMatch) { doi = decodeURIComponent(doiMatch[1]); break; }
      }
      var snippetEl = el.querySelector('.gs_rs');
      var snippet = snippetEl ? (snippetEl.textContent || '').trim() : '';
      results.push({ title: title, authors: authors, year: year, doi: doi, url: url, snippet: snippet });
    }
    return results;
  }

  // Poll at 100ms intervals up to 2500ms. CAPTCHA check runs every tick so
  // we short-circuit immediately instead of waiting out the rest of the
  // deadline on a page that will never render results.
  var DEADLINE = Date.now() + 2500;
  while (Date.now() < DEADLINE) {
    if (detectCaptcha()) return { captcha: true, results: [] };
    var items = findItems();
    if (items.length > 0) return { captcha: false, results: extract(items) };
    await new Promise(function(r) { setTimeout(r, 100); });
  }
  // Timed out. Re-check CAPTCHA once more (some Scholar variants render
  // the CAPTCHA iframe after a delay) and otherwise return empty results.
  return { captcha: detectCaptcha(), results: [] };
})()
`

// --- Rate limiter ---

class ScholarRateLimiter {
  private baseDelay = 4000
  private lastRequest = 0
  private captchaCount = 0
  private requestsSinceCaptcha = Infinity

  async waitForSlot(): Promise<void> {
    const jitter = Math.random() * 3000
    let delay = this.baseDelay + jitter

    if (this.requestsSinceCaptcha < 5) {
      delay = 8000 + Math.random() * 4000
    }
    if (this.captchaCount >= 2) {
      delay = Math.max(delay, 10000 + Math.random() * 5000)
    }

    const elapsed = Date.now() - this.lastRequest
    if (elapsed < delay) {
      await sleep(delay - elapsed)
    }
    this.lastRequest = Date.now()
    this.requestsSinceCaptcha++
  }

  onCaptcha(): void {
    this.captchaCount++
    this.requestsSinceCaptcha = 0
  }

  reset(): void {
    this.lastRequest = 0
    this.captchaCount = 0
    this.requestsSinceCaptcha = Infinity
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// --- Scanner ---

export class ScholarScanner {
  private webview: any = null
  private overlayWebview: any = null
  private queue: ScholarQueueItem[] = []
  private currentIndex = 0
  private foundCount = 0
  private status: ScholarScanStatus = 'idle'
  private callbacks: ScholarScanCallbacks | null = null
  private rateLimiter = new ScholarRateLimiter()
  private cancelRequested = false
  // Bumped on every loadAndExtract call. The load closure captures its own
  // generation and checks after each await — if the counter has moved
  // forward, a newer call (or a cancellation) owns the webview now, so the
  // stale closure must not execute JS against it or resolve/reject.
  private loadGeneration = 0

  setWebview(webview: any): void {
    this.webview = webview
    console.log(`[Scholar] Webview ${webview ? 'connected' : 'disconnected'}`)
  }

  setOverlayWebview(webview: any): void {
    this.overlayWebview = webview
  }

  setCallbacks(callbacks: ScholarScanCallbacks): void {
    this.callbacks = callbacks
  }

  getStatus(): ScholarScanStatus {
    return this.status
  }

  async startScan(queue: ScholarQueueItem[]): Promise<void> {
    if (this.status === 'scanning') return
    this.queue = queue
    this.currentIndex = 0
    this.foundCount = 0
    this.cancelRequested = false
    this.rateLimiter.reset()
    this.setStatus('scanning')
    this.callbacks?.onProgress(0, queue.length, 0)
    await this.processNext()
  }

  cancel(): void {
    this.cancelRequested = true
    // Bump the generation so any in-flight loadAndExtract closure sees
    // `isStale() === true` on its next await and bails without touching
    // the webview or resolving its promise.
    this.loadGeneration++
    this.setStatus('cancelled')
  }

  async resumeAfterCaptcha(): Promise<void> {
    console.log(`[Scholar] resumeAfterCaptcha called (status=${this.status})`)
    if (this.status !== 'captcha') {
      console.warn('[Scholar] Ignoring resume — not in captcha state')
      return
    }

    const item = this.queue[this.currentIndex]
    if (!item) {
      console.warn('[Scholar] No current item, marking done')
      this.setStatus('done')
      return
    }

    // Prevent re-entry
    this.setStatus('scanning')

    // Try to extract results from the overlay webview (user solved CAPTCHA there)
    const overlay = this.overlayWebview
    let candidates: ScholarCandidate[] = []
    console.log(`[Scholar] Overlay webview available: ${!!overlay}`)
    if (overlay) {
      try {
        await sleep(500)
        const extraction = await overlay.executeJavaScript(POLL_AND_EXTRACT_SCRIPT)
        console.log('[Scholar] Overlay extraction:', JSON.stringify(extraction).substring(0, 300))
        if (extraction && Array.isArray(extraction.results)) {
          candidates = extraction.results
        }
      } catch (err) {
        console.warn('[Scholar] Overlay extraction failed (overlay may be closed):', err)
      }
    }

    // Always close the overlay (no-op if already closed)
    try {
      this.callbacks?.onCaptchaResolved()
    } catch (err) {
      console.warn('[Scholar] onCaptchaResolved failed:', err)
    }

    // Always score, even with an empty candidate list, so the backend records
    // "Google Scholar" in databases_searched and the UI gets its GS link.
    let updated = false
    try {
      const response = await api.scoreScholar(
        item.pdfId,
        item.sourceId,
        item.searchText,
        candidates,
      )
      updated = response.updated
      if (updated) this.foundCount++
    } catch (err) {
      this.callbacks?.onError(item.sourceId, `Scoring error: ${err}`)
    }
    this.callbacks?.onSourceDone(item.sourceId, updated)

    // Advance to next item
    this.currentIndex++
    this.callbacks?.onProgress(this.currentIndex, this.queue.length, this.foundCount)

    console.log(`[Scholar] Continuing to next (${this.currentIndex}/${this.queue.length})`)
    await this.processNext()
  }

  private setStatus(status: ScholarScanStatus): void {
    this.status = status
    this.callbacks?.onStatusChange(status)
  }

  private async processNext(): Promise<void> {
    // One rate-limit slot is "pre-reserved" by the previous iteration during
    // its scoring POST, so the wait runs concurrently with the backend call
    // instead of serially after it. null means "no pre-reserved slot, call
    // waitForSlot fresh" — used on the very first iteration and when resuming
    // after a CAPTCHA (where the pre-reserved slot was never created).
    let nextSlotWait: Promise<void> | null = null

    while (!this.cancelRequested && this.currentIndex < this.queue.length) {
      const item = this.queue[this.currentIndex]

      if (nextSlotWait !== null) {
        await nextSlotWait
        nextSlotWait = null
      } else {
        await this.rateLimiter.waitForSlot()
      }
      if (this.cancelRequested) return

      const query = encodeURIComponent(item.searchText.slice(0, 300))
      // lookup=0 forces full results page (without it Scholar may show single "best result")
      const url = `https://scholar.google.com/scholar?lookup=0&q=${query}`
      console.log(`[Scholar] Searching: ${url.substring(0, 120)}...`)

      let candidates: ScholarCandidate[] | 'captcha'
      try {
        candidates = await this.loadAndExtract(url)
      } catch (err) {
        this.callbacks?.onError(item.sourceId, `${err}`)
        this.currentIndex++
        this.callbacks?.onProgress(this.currentIndex, this.queue.length, this.foundCount)
        continue
      }

      console.log(`[Scholar] Got ${candidates === 'captcha' ? 'CAPTCHA' : candidates.length + ' candidates'}`)

      if (candidates === 'captcha') {
        this.rateLimiter.onCaptcha()
        this.setStatus('captcha')
        this.callbacks?.onCaptcha(url)
        return // Will resume from resumeAfterCaptcha()
      }

      // Kick off scoring in the background. Crucially, we also pre-reserve
      // the next iteration's rate-limit slot right now so that its 4–7 s
      // sleep runs in parallel with the ~100–500 ms scoring POST, instead
      // of serially after it. Only pre-reserve when a next iteration will
      // actually exist — otherwise the reservation is wasted and leaves
      // `lastRequest` stale at shutdown.
      // Always call scoreScholar — even with an empty candidate list — so the
      // backend records "Google Scholar" in databases_searched and broadcasts
      // it to the UI. Without this, a scanned-but-empty source has no GS link.
      const scorePromise: Promise<{ updated: boolean } | null> = api
        .scoreScholar(item.pdfId, item.sourceId, item.searchText, candidates)
        .catch((err) => {
          this.callbacks?.onError(item.sourceId, `Scoring error: ${err}`)
          return null
        })

      if (this.currentIndex + 1 < this.queue.length && !this.cancelRequested) {
        nextSlotWait = this.rateLimiter.waitForSlot()
      }

      const response = await scorePromise
      const updated = response?.updated ?? false
      if (updated) this.foundCount++
      this.callbacks?.onSourceDone(item.sourceId, updated)

      this.currentIndex++
      this.callbacks?.onProgress(this.currentIndex, this.queue.length, this.foundCount)
    }

    if (!this.cancelRequested) this.setStatus('done')
  }

  private loadAndExtract(url: string): Promise<ScholarCandidate[] | 'captcha'> {
    // Capture the generation at the start of this call; every async step
    // below re-checks it and bails silently if a newer call has taken over
    // the shared webview. This prevents the old closure from running JS
    // against a page that belongs to the *next* citation.
    const myGen = ++this.loadGeneration
    const isStale = (): boolean => this.loadGeneration !== myGen

    return new Promise((resolve, reject) => {
      const view = this.webview
      if (!view) {
        reject(new Error('No webview available'))
        return
      }

      let settled = false
      const timeoutId = setTimeout(() => {
        if (!settled) {
          settled = true
          cleanup()
          reject(new Error('Webview load timeout'))
        }
      }, 30000)

      const cleanup = (): void => {
        try {
          view.removeEventListener('did-stop-loading', onLoaded)
          view.removeEventListener('did-fail-load', onFailed)
        } catch {
          // ignore
        }
      }

      const onFailed = (e: any): void => {
        if (settled) return
        settled = true
        clearTimeout(timeoutId)
        cleanup()
        reject(new Error(`Load failed: ${e?.errorDescription || 'unknown'}`))
      }

      const onLoaded = async (): Promise<void> => {
        if (settled) return
        settled = true
        clearTimeout(timeoutId)
        cleanup()

        try {
          // Single async call: polls the DOM up to 2500ms for either a
          // CAPTCHA marker or result items, extracts in the same pass,
          // and returns as soon as either is found. Most Scholar result
          // pages resolve here in 200-500ms — the full 2.5s is only spent
          // on pages that never render (soft blocks, empty results).
          const extraction = await view.executeJavaScript(POLL_AND_EXTRACT_SCRIPT)
          if (isStale()) {
            console.warn('[Scholar] stale onLoaded after extraction — discarding results')
            return
          }
          if (extraction && extraction.captcha) {
            resolve('captcha')
            return
          }
          if (extraction && Array.isArray(extraction.results)) {
            resolve(extraction.results)
            return
          }
          // Unexpected shape — dump the page and return empty
          const debugInfo = await view.executeJavaScript(`({
            url: window.location.href,
            title: document.title,
            bodyLen: document.body?.innerText?.length || 0,
            html: document.documentElement.outerHTML.substring(0, 500)
          })`)
          if (isStale()) return
          console.warn('[Scholar] Extraction returned unexpected shape. Page info:', debugInfo)
          resolve([])
        } catch (err) {
          if (isStale()) return
          reject(new Error(`Extraction failed: ${err}`))
        }
      }

      view.addEventListener('did-stop-loading', onLoaded)
      view.addEventListener('did-fail-load', onFailed)

      // Navigate by setting src attribute (works reliably with Electron webview)
      try {
        if (typeof view.loadURL === 'function') {
          view.loadURL(url)
        } else {
          view.src = url
        }
      } catch (err) {
        if (!settled) {
          settled = true
          clearTimeout(timeoutId)
          cleanup()
          reject(new Error(`Navigation failed: ${err}`))
        }
      }
    })
  }
}

// Singleton instance
export const scholarScanner = new ScholarScanner()
