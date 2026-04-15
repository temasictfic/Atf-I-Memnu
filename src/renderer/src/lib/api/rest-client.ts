import { getBackendBaseUrl } from './backend-endpoint'

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const baseUrl = await getBackendBaseUrl()
  const opts: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' }
  }
  if (body !== undefined) {
    opts.body = JSON.stringify(body)
  }
  const res = await fetch(`${baseUrl}${path}`, opts)
  if (!res.ok) {
    const errorText = await res.text()
    throw new Error(`API error ${res.status}: ${errorText}`)
  }
  return res.json()
}

export const api = {
  // Health
  health: () => request<{ status: string }>('GET', '/api/health'),

  // Source cache persistence — the backend no longer parses PDFs; these
  // endpoints read and write the `{output_dir}/cache/{pdf_id}.json` files
  // that the client-side orchestrator populates after parsing.
  getSources: (pdfId: string) =>
    request<{
      sources: Array<import('./types').SourceRectangle>
      cached: boolean
      numbered?: boolean
      approved?: boolean
    }>('GET', `/api/parse/sources/${pdfId}`),

  updateSources: (
    pdfId: string,
    sources: Array<import('./types').SourceRectangle>,
    numbered?: boolean,
  ) =>
    request<{ success: boolean }>('PUT', `/api/parse/sources/${pdfId}`, {
      sources,
      ...(numbered !== undefined ? { numbered } : {}),
    }),

  approvePdf: (pdfId: string) =>
    request<{ success: boolean }>('POST', `/api/parse/approve/${pdfId}`),

  unapprovePdf: (pdfId: string) =>
    request<{ success: boolean }>('POST', `/api/parse/unapprove/${pdfId}`),

  removePdf: (pdfId: string) =>
    request<{ success: boolean }>('DELETE', `/api/parse/pdf/${pdfId}`),

  // NER field extraction — the only remaining backend-side PDF-ish work.
  extractFields: (text: string) =>
    request<import('./types').ParsedSource>('POST', '/api/parse/extract-fields', { text }),

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

  overrideStatus: (pdfId: string, sourceId: string, status: 'found' | 'problematic' | 'not_found') =>
    request<{ success: boolean }>('PUT', `/api/verify/override/${pdfId}/${sourceId}`, { status }),

  scoreScholar: (pdfId: string, sourceId: string, sourceText: string, candidates: import('./types').ScholarCandidate[]) =>
    request<import('./types').ScoreScholarResponse>('POST', '/api/verify/score-scholar', {
      pdf_id: pdfId, source_id: sourceId, source_text: sourceText, candidates,
    }),

  // Settings
  getSettings: () =>
    request<import('./types').AppSettings>('GET', '/api/settings'),

  updateSettings: (settings: import('./types').AppSettings) =>
    request<import('./types').AppSettings>('PUT', '/api/settings', settings)
}
