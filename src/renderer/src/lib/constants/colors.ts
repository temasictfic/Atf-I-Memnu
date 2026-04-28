// Centralized color palette. Renderer code (status pills, score chips, PDF
// export) imports from here so the same hex/RGB pair can't drift between
// the live UI and exported reports.
//
// Two parallel forms are exported:
//   STATUS_HEX / DB_SCORE_HEX / TRUST_HEX  → CSS-friendly "#rrggbb" strings
//   STATUS_RGB / DB_SCORE_RGB / TRUST_RGB → [r, g, b] floats in [0, 1] for pdf-lib
//
// Hex and RGB tuples for the same status MUST encode the same color.

type RgbTuple = readonly [number, number, number]

// --- Verification status (found / problematic / not_found / in_progress / pending) ---

export const STATUS_HEX = {
  found:       '#22c55e',
  problematic: '#f59e0b',
  not_found:   '#ef4444',
  in_progress: '#3b82f6',
  pending:     '#9ca3af',
  neutral:     '#a8a29e',
} as const

export const STATUS_RGB: Record<keyof typeof STATUS_HEX, RgbTuple> = {
  found:       [0.133, 0.773, 0.369],
  problematic: [0.961, 0.620, 0.043],
  not_found:   [0.937, 0.267, 0.267],
  in_progress: [0.231, 0.510, 0.965],
  pending:     [0.612, 0.639, 0.686],
  neutral:     [0.659, 0.635, 0.604],
}

// --- Per-database score chip (high / medium / low) ---

export const DB_SCORE_HEX = {
  high:   '#22c55e',
  medium: '#eab308',
  low:    '#ef4444',
} as const

export const DB_SCORE_RGB: Record<keyof typeof DB_SCORE_HEX, RgbTuple> = {
  high:   [0.133, 0.773, 0.369],
  medium: [0.918, 0.702, 0.031],
  low:    [0.937, 0.267, 0.267],
}

// --- Trust-tag palette (Geçerli / Künye / Uydurma) ---

export const TRUST_HEX = {
  validBorder:   '#86efac',
  validText:     '#166534',
  kunyeBorder:   '#94a3b8',
  kunyeText:     '#334155',
  uydurmaBorder: '#e879f9',
  uydurmaText:   '#86198f',
} as const

export const TRUST_RGB: Record<keyof typeof TRUST_HEX, RgbTuple> = {
  validBorder:   [0.525, 0.937, 0.675],
  validText:     [0.086, 0.396, 0.204],
  kunyeBorder:   [0.580, 0.639, 0.722],
  kunyeText:     [0.200, 0.255, 0.333],
  uydurmaBorder: [0.910, 0.475, 0.976],
  uydurmaText:   [0.525, 0.098, 0.561],
}
