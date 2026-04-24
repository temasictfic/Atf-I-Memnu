// PDF and parsing types
export interface PdfDocument {
  id: string
  name: string
  path: string
  status: 'pending' | 'parsing' | 'parsed' | 'approved' | 'error'
  source_count: number
  numbered: boolean
  error?: string
}

export interface BoundingBox {
  x0: number
  y0: number
  x1: number
  y1: number
  page: number
}

export interface SourceRectangle {
  id: string
  pdf_id: string
  bbox: BoundingBox
  bboxes?: BoundingBox[]  // multi-page: one bbox per page
  text: string
  ref_number?: number
  status: 'detected' | 'edited' | 'approved'
}

export interface PageData {
  page_num: number
  width: number
  height: number
}

// Parsed source fields (NER extraction result)
export interface ParsedSource {
  raw_text: string
  title: string
  authors: string[]
  year?: number
  url?: string
  source?: string
  citation_format?: string
  extraction_method: string
  parse_confidence: number
}

// Verification types
export type VerifyStatus = 'found' | 'problematic' | 'not_found' | 'pending' | 'in_progress'

export type ProblemTag = '!authors' | '!doi/arXiv' | '!year' | '!source' | '!title'

export type TrustTag = 'clean' | 'künye' | 'uydurma'

export type TagKey = 'authors' | 'year' | 'title' | 'source' | 'doi/arXiv'

export interface MatchResult {
  database: string
  title: string
  authors: string[]
  year?: number
  doi?: string
  journal?: string
  url: string
  search_url: string
  score: number
  match_details: {
    title_similarity: number
    author_match: number
    year_match: number
    url_match: boolean
  }
}

export interface VerificationResult {
  source_id: string
  status: VerifyStatus
  problem_tags: string[]
  trust_tag?: TrustTag
  // Three-state user override for the trust pill. null = use trust_tag.
  trust_tag_override?: TrustTag | null
  tag_overrides?: Record<string, boolean>
  url_liveness: Record<string, boolean>
  best_match?: MatchResult
  all_results: MatchResult[]
  databases_searched: string[]
  // Pre-built Google Scholar / Google Search URLs using the NER-extracted title
  scholar_url?: string
  google_url?: string
}

export interface PdfVerificationSummary {
  pdf_id: string
  found: number
  problematic: number
  not_found: number
  in_progress: number
  total: number
  completed: boolean
}

// Settings types
export interface DatabaseConfig {
  id: string
  name: string
  enabled: boolean
}

export interface AppSettings {
  annotated_pdf_dir?: string
  databases: DatabaseConfig[]
  api_keys?: Record<string, string>
  polite_pool_email?: string
  // ISO-8601 date the user's OpenAIRE refresh token was last saved. The UI
  // derives "connected" state from the presence of api_keys.openaire and
  // uses this date to warn about the 1-month expiry window.
  openaire_token_saved_at?: string
  search_timeout: number
  max_concurrent_apis: number
  max_concurrent_sources_per_pdf: number
  auto_scholar_after_verify?: boolean
  language?: 'tr' | 'en'
  auto_callout_text_uydurma?: string
  auto_callout_text_kunye?: string
}

// WebSocket event types
export interface WsEvent {
  type: string
  data: Record<string, unknown>
}

export interface LogEntry {
  id: string
  timestamp: string
  level: 'info' | 'success' | 'warning' | 'error'
  message: string
  pdf_id?: string
  source_id?: string
  database?: string
  group_key?: string
}

// Verification progress tracking
export type DbCheckStatus = 'checking' | 'found' | 'not_found' | 'timeout' | 'error' | 'rate_limited' | 'skipped'

export interface DbCheckEntry {
  name: string
  status: DbCheckStatus
  searchUrl?: string
}

export interface SourceVerifyProgress {
  currentDb: string | null
  checkedDbs: DbCheckEntry[]
}

// Parse response types
export interface ParseResponse {
  job_id: string
}

export interface ParseStatusResponse {
  pdfs: PdfDocument[]
}

export interface VerifyResponse {
  job_id: string
}

// Google Scholar scan types
export interface ScholarCandidate {
  title: string
  authors: string[]
  year?: number
  doi?: string
  url: string
  snippet?: string
  apa_citation?: string
  scraped_truncated?: boolean
  cid?: string
}

export interface ScoreScholarResponse {
  updated: boolean
  result: VerificationResult | null
}
