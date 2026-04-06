// PDF and parsing types
export interface PdfDocument {
  id: string
  name: string
  path: string
  status: 'pending' | 'parsing' | 'parsed' | 'approved' | 'error'
  source_count: number
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

// Verification types
export type VerifyStatus = 'green' | 'yellow' | 'red' | 'black' | 'pending' | 'in_progress'

export interface MatchResult {
  database: string
  title: string
  authors: string[]
  year?: number
  doi?: string
  url: string
  search_url: string
  score: number
  match_details: {
    title_similarity: number
    author_match: number
    year_match: number
    journal_match: number
  }
}

export interface VerificationResult {
  source_id: string
  status: VerifyStatus
  best_match?: MatchResult
  all_results: MatchResult[]
  databases_searched: string[]
}

export interface PdfVerificationSummary {
  pdf_id: string
  green: number
  yellow: number
  red: number
  black: number
  in_progress: number
  total: number
  completed: boolean
}

// Settings types
export interface DatabaseConfig {
  id: string
  name: string
  enabled: boolean
  tier: 1 | 2
  type: 'api'
}

export interface AppSettings {
  databases: DatabaseConfig[]
  api_keys?: Record<string, string>
  search_timeout: number
  max_concurrent_apis: number
  max_concurrent_sources_per_pdf: number
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
export type DbCheckStatus = 'checking' | 'found' | 'not_found' | 'timeout' | 'error' | 'captcha' | 'blocked'

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
