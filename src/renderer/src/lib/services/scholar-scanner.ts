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
// Uses multiple selector strategies to handle DOM variations.

const EXTRACT_RESULTS_SCRIPT = `
(function() {
  try {
    var results = [];

    // Strategy 1: standard result items
    var items = document.querySelectorAll('.gs_r.gs_or.gs_scl');
    // Strategy 2: broader container
    if (!items.length) items = document.querySelectorAll('.gs_r.gs_or');
    // Strategy 3: even broader
    if (!items.length) items = document.querySelectorAll('.gs_ri');
    // Strategy 4: data-cid attribute based
    if (!items.length) items = document.querySelectorAll('[data-cid]');

    for (var i = 0; i < items.length; i++) {
      var el = items[i];

      // Try multiple selectors for the title
      var titleEl = el.querySelector('.gs_rt a')
        || el.querySelector('h3 a')
        || el.querySelector('a[data-clk]');
      if (!titleEl) continue;

      var rawTitle = titleEl.textContent || '';
      // Remove leading [PDF], [HTML], [BOOK] etc.
      var title = rawTitle.replace(/^\\s*\\[.*?\\]\\s*/, '').trim();
      if (!title) continue;

      var url = titleEl.href || '';

      // Author/venue metadata line
      var metaEl = el.querySelector('.gs_a');
      var metaText = metaEl ? (metaEl.textContent || '') : '';

      // Parse "A Author, B Author - Journal, 2023 - publisher"
      var parts = metaText.split(' - ');
      var authorsPart = (parts[0] || '').trim();
      var authors = authorsPart
        .split(',')
        .map(function(a) { return a.trim(); })
        .filter(function(a) { return a.length > 0 && a !== '\\u2026'; });

      var year = null;
      var yearMatch = metaText.match(/\\b(19|20)\\d{2}\\b/);
      if (yearMatch) year = parseInt(yearMatch[0]);

      // Extract DOI from any link in this result
      var doi = null;
      var links = el.querySelectorAll('a');
      for (var j = 0; j < links.length; j++) {
        var href = links[j].href || '';
        var doiMatch = href.match(/doi\\.org\\/(10\\.\\d{4,}\\/.+?)(?:[?&#]|$)/);
        if (doiMatch) { doi = decodeURIComponent(doiMatch[1]); break; }
      }

      // Snippet
      var snippetEl = el.querySelector('.gs_rs');
      var snippet = snippetEl ? (snippetEl.textContent || '').trim() : '';

      results.push({
        title: title,
        authors: authors,
        year: year,
        doi: doi,
        url: url,
        snippet: snippet
      });
    }
    return { ok: true, results: results, itemCount: items.length };
  } catch(e) {
    return { ok: false, error: e.message, results: [] };
  }
})()
`

const DETECT_CAPTCHA_SCRIPT = `
(function() {
  var hasCaptchaForm = !!document.querySelector('#gs_captcha_f, #gs_captcha_ccl, #captcha-form, #recaptcha');
  var hasRecaptcha = !!document.querySelector('iframe[src*="recaptcha"], iframe[src*="captcha"]');
  var isSorryPage = window.location.hostname.includes('sorry.google.com');
  var titleSorry = document.title.toLowerCase().includes('sorry')
    || document.title.toLowerCase().includes('unusual traffic');
  // Also detect when body has very little content (empty/blocked page)
  var bodyText = (document.body && document.body.innerText) || '';
  var isBlocked = bodyText.includes('unusual traffic') || bodyText.includes('not a robot');
  return hasCaptchaForm || hasRecaptcha || isSorryPage || titleSorry || isBlocked;
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
        const extraction = await overlay.executeJavaScript(EXTRACT_RESULTS_SCRIPT)
        console.log('[Scholar] Overlay extraction:', JSON.stringify(extraction).substring(0, 300))
        if (extraction?.ok && Array.isArray(extraction.results)) {
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

    // Score whatever we got (may be empty — that's OK, we still advance)
    let updated = false
    if (candidates.length > 0) {
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
    } else {
      console.log('[Scholar] No candidates extracted — skipping this reference')
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
    if (this.cancelRequested || this.currentIndex >= this.queue.length) {
      if (!this.cancelRequested) this.setStatus('done')
      return
    }

    const item = this.queue[this.currentIndex]

    // Rate limit
    await this.rateLimiter.waitForSlot()
    if (this.cancelRequested) return

    // Navigate to Google Scholar
    const query = encodeURIComponent(item.searchText.slice(0, 300))
    // lookup=0 forces full results page (without it Scholar may show single "best result")
    const url = `https://scholar.google.com/scholar?lookup=0&q=${query}`

    console.log(`[Scholar] Searching: ${url.substring(0, 120)}...`)

    try {
      const candidates = await this.loadAndExtract(url)

      console.log(`[Scholar] Got ${candidates === 'captcha' ? 'CAPTCHA' : candidates.length + ' candidates'}`)

      if (candidates === 'captcha') {
        this.rateLimiter.onCaptcha()
        this.setStatus('captcha')
        this.callbacks?.onCaptcha(url)
        return // Will resume from resumeAfterCaptcha()
      }

      // Send to backend for scoring
      let updated = false
      if (candidates.length > 0) {
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
      }

      this.callbacks?.onSourceDone(item.sourceId, updated)
    } catch (err) {
      this.callbacks?.onError(item.sourceId, `${err}`)
    }

    this.currentIndex++
    this.callbacks?.onProgress(this.currentIndex, this.queue.length, this.foundCount)

    // Continue to next
    await this.processNext()
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

        // Wait for page JS to finish rendering
        await sleep(2500)
        if (isStale()) {
          console.warn('[Scholar] stale onLoaded after sleep — aborting extraction')
          return
        }

        try {
          // Check for CAPTCHA first
          const isCaptcha = await view.executeJavaScript(DETECT_CAPTCHA_SCRIPT)
          if (isStale()) {
            console.warn('[Scholar] stale onLoaded after captcha check — aborting')
            return
          }
          if (isCaptcha) {
            resolve('captcha')
            return
          }

          // Extract results
          const extraction = await view.executeJavaScript(EXTRACT_RESULTS_SCRIPT)
          if (isStale()) {
            console.warn('[Scholar] stale onLoaded after extraction — discarding results')
            return
          }
          console.log('[Scholar] Extraction result:', JSON.stringify(extraction).substring(0, 500))
          if (extraction && extraction.ok && Array.isArray(extraction.results)) {
            resolve(extraction.results)
          } else {
            // Dump page info for debugging
            const debugInfo = await view.executeJavaScript(`({
              url: window.location.href,
              title: document.title,
              bodyLen: document.body?.innerText?.length || 0,
              html: document.documentElement.outerHTML.substring(0, 500)
            })`)
            if (isStale()) return
            console.warn('[Scholar] Extraction failed. Page info:', debugInfo)
            resolve([])
          }
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
