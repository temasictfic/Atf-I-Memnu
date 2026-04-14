// Preload injected into every guest page loaded under the
// `persist:scholar-panel` partition. Its only job is to scrub the JS-side
// fingerprints that reveal the embedder is Electron, so Cloudflare Turnstile
// (and similar bot challenges on academia.edu, IEEE Xplore, etc.) treat the
// webview like a normal Chrome browser.
//
// Header-level scrubbing of Sec-CH-UA is done in the main process via
// session.webRequest.onBeforeSendHeaders — this file handles the matching
// renderer-side surfaces (navigator.userAgentData, navigator.webdriver, etc.)
// so the two stay consistent.

(() => {
  const chromeVersion = (() => {
    const match = navigator.userAgent.match(/Chrome\/(\d+)/)
    return match ? match[1] : '131'
  })()

  const fakeBrands = [
    { brand: 'Chromium', version: chromeVersion },
    { brand: 'Google Chrome', version: chromeVersion },
    { brand: 'Not?A_Brand', version: '24' },
  ]

  const fakeUaData = {
    brands: fakeBrands,
    mobile: false,
    platform: 'Windows',
    getHighEntropyValues(hints: string[]): Promise<Record<string, unknown>> {
      const result: Record<string, unknown> = {
        brands: fakeBrands,
        mobile: false,
        platform: 'Windows',
      }
      for (const hint of hints) {
        switch (hint) {
          case 'architecture': result.architecture = 'x86'; break
          case 'bitness': result.bitness = '64'; break
          case 'model': result.model = ''; break
          case 'platformVersion': result.platformVersion = '15.0.0'; break
          case 'uaFullVersion': result.uaFullVersion = `${chromeVersion}.0.0.0`; break
          case 'fullVersionList': result.fullVersionList = fakeBrands.map(b => ({ ...b, version: `${b.version}.0.0.0` })); break
          case 'wow64': result.wow64 = false; break
        }
      }
      return Promise.resolve(result)
    },
    toJSON() {
      return { brands: fakeBrands, mobile: false, platform: 'Windows' }
    },
  }

  try {
    Object.defineProperty(navigator, 'userAgentData', {
      get: () => fakeUaData,
      configurable: true,
    })
  } catch {
    // Some pages may have already locked it; nothing we can do.
  }

  try {
    Object.defineProperty(navigator, 'webdriver', {
      get: () => false,
      configurable: true,
    })
  } catch {
    // ignore
  }

  // Cloudflare also looks for a populated chrome.runtime object — Electron has
  // it in the renderer but not always in subframes. Make sure it exists.
  try {
    const w = window as unknown as { chrome?: Record<string, unknown> }
    if (!w.chrome) {
      w.chrome = { runtime: {} }
    } else if (!w.chrome.runtime) {
      w.chrome.runtime = {}
    }
  } catch {
    // ignore
  }
})()
