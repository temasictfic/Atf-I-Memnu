const BASE_URL = 'http://localhost:18765'

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const opts: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' }
  }
  if (body !== undefined) {
    opts.body = JSON.stringify(body)
  }
  const res = await fetch(`${BASE_URL}${path}`, opts)
  if (!res.ok) {
    const errorText = await res.text()
    throw new Error(`API error ${res.status}: ${errorText}`)
  }
  return res.json()
}

export function pageImageUrl(pdfId: string, pageNum: number): string {
  return `${BASE_URL}/api/parse/page-image/${pdfId}/${pageNum}`
}

export const api = {
  // Health
  health: () => request<{ status: string }>('GET', '/api/health'),

  // Parsing
  parseDirectory: (directory: string) =>
    request<{ job_id: string }>('POST', '/api/parse', { directory }),

  parseFiles: (filePaths: string[]) =>
    request<{ job_id: string }>('POST', '/api/parse', { file_paths: filePaths }),

  parseStatus: (jobId: string) =>
    request<{ pdfs: Array<{ id: string; name: string; status: string; source_count: number }> }>('GET', `/api/parse/status/${jobId}`),

  getPages: (pdfId: string) =>
    request<{ pages: Array<import('./types').PageData> }>('GET', `/api/parse/pages/${pdfId}`),

  getSources: (pdfId: string) =>
    request<{ sources: Array<import('./types').SourceRectangle> }>('GET', `/api/parse/sources/${pdfId}`),

  updateSources: (pdfId: string, sources: Array<import('./types').SourceRectangle>) =>
    request<{ success: boolean }>('PUT', `/api/parse/sources/${pdfId}`, { sources }),

  approvePdf: (pdfId: string) =>
    request<{ success: boolean }>('POST', `/api/parse/approve/${pdfId}`),

  unapprovePdf: (pdfId: string) =>
    request<{ success: boolean }>('POST', `/api/parse/unapprove/${pdfId}`),

  revertPdf: (pdfId: string) =>
    request<{ sources: Array<import('./types').SourceRectangle> }>('POST', `/api/parse/revert/${pdfId}`),

  extractText: (pdfId: string, page: number, x0: number, y0: number, x1: number, y1: number) =>
    request<{ text: string }>('POST', `/api/parse/extract-text/${pdfId}`, { page, x0, y0, x1, y1 }),

  getLastDirectory: () =>
    request<{ directory: string }>('GET', '/api/parse/last-directory'),

  // Verification
  verify: (pdfIds: string[]) =>
    request<{ job_id: string }>('POST', '/api/verify', { pdf_ids: pdfIds }),

  verifyBatch: (pdfIds: string[], texts: Record<string, string>, excludedIds: string[]) =>
    request<{ job_id: string }>('POST', '/api/verify/batch', { pdf_ids: pdfIds, texts, excluded_ids: excludedIds }),

  verifyPdf: (pdfId: string) =>
    request<{ job_id: string }>('POST', `/api/verify/pdf/${pdfId}`),

  verifySource: (pdfId: string, sourceId: string, text?: string) =>
    request<{ success: boolean }>('POST', `/api/verify/source/${pdfId}/${sourceId}`, { text }),

  cancelVerification: () =>
    request<{ success: boolean }>('POST', '/api/verify/cancel'),

  cancelPdfVerification: (pdfId: string) =>
    request<{ success: boolean }>('POST', `/api/verify/cancel/pdf/${pdfId}`),

  cancelSourceVerification: (sourceId: string) =>
    request<{ success: boolean }>('POST', `/api/verify/cancel/source/${sourceId}`),

  verifyStatus: (jobId: string) =>
    request<{ pdfs: Array<import('./types').PdfVerificationSummary> }>('GET', `/api/verify/status/${jobId}`),

  verifyResults: (pdfId: string) =>
    request<{ results: Record<string, import('./types').VerificationResult> }>('GET', `/api/verify/results/${pdfId}`),

  overrideStatus: (pdfId: string, sourceId: string, status: 'green' | 'yellow' | 'red' | 'black') =>
    request<{ success: boolean }>('PUT', `/api/verify/override/${pdfId}/${sourceId}`, { status }),

  // Settings
  getSettings: () =>
    request<import('./types').AppSettings>('GET', '/api/settings'),

  updateSettings: (settings: import('./types').AppSettings) =>
    request<import('./types').AppSettings>('PUT', '/api/settings', settings)
}
