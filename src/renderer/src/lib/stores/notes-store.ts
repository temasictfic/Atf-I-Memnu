// Client-side notes store. Notes are user-authored annotations (highlights
// over text regions, free-text callouts) that can be exported into a copy of
// the original PDF via the pdf-lib annotation writer.
//
// Persistence is in-memory only for now — we can add a backend JSON sidecar
// later once the core UX is working.

import { create } from 'zustand'

export type NoteKind = 'highlight' | 'callout'

export interface NoteQuad {
  // A single highlight rectangle in page-local pixel coordinates (SCALE space),
  // top-left origin. Multiple quads allow multi-line text selections.
  x0: number
  y0: number
  x1: number
  y1: number
}

export interface Note {
  id: string
  pdfId: string
  // 0-indexed page number, matching SourceRectangle.bbox.page
  pageNum: number
  kind: NoteKind
  // Overall bbox (union of quads for highlights, or the drawn rect for callouts)
  bbox: NoteQuad
  // For multi-line highlights — one entry per selection rect. When absent, the
  // exporter falls back to `bbox` as a single-quad highlight.
  quads?: NoteQuad[]
  // Body text: optional comment for highlights, visible text for callouts.
  // May contain `\n` for multi-line callouts.
  text: string
  // Hex color (e.g. "#fde68a"). Applied to both the annotation appearance and
  // the in-app overlay.
  color: string
  // Callout-only typography. Highlights ignore these.
  fontSize?: number // defaults to DEFAULT_CALLOUT_FONT_SIZE
  bold?: boolean // defaults to false
  createdAt: number
}

export const DEFAULT_CALLOUT_FONT_SIZE = 11
export const CALLOUT_FONT_SIZE_MIN = 6
export const CALLOUT_FONT_SIZE_MAX = 48

interface NotesState {
  notesByPdf: Record<string, Note[]>
  activeKind: NoteKind | null
  activeColor: string
}

const DEFAULT_COLOR_BY_KIND: Record<NoteKind, string> = {
  highlight: '#fde68a',
  callout: '#fca5a5',
}

export const useNotesStore = create<NotesState>()(() => ({
  notesByPdf: {},
  activeKind: null,
  activeColor: DEFAULT_COLOR_BY_KIND.highlight,
}))

export function getNotes(pdfId: string): Note[] {
  return useNotesStore.getState().notesByPdf[pdfId] ?? []
}

export function addNote(note: Omit<Note, 'id' | 'createdAt'>): Note {
  const full: Note = {
    ...note,
    id: `note_${note.pdfId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    createdAt: Date.now(),
  }
  useNotesStore.setState(state => {
    const list = state.notesByPdf[full.pdfId] ?? []
    return {
      notesByPdf: { ...state.notesByPdf, [full.pdfId]: [...list, full] },
    }
  })
  return full
}

export function updateNote(pdfId: string, noteId: string, patch: Partial<Note>): void {
  useNotesStore.setState(state => {
    const list = state.notesByPdf[pdfId]
    if (!list) return state
    return {
      notesByPdf: {
        ...state.notesByPdf,
        [pdfId]: list.map(n => (n.id === noteId ? { ...n, ...patch } : n)),
      },
    }
  })
}

export function removeNote(pdfId: string, noteId: string): void {
  useNotesStore.setState(state => {
    const list = state.notesByPdf[pdfId]
    if (!list) return state
    return {
      notesByPdf: {
        ...state.notesByPdf,
        [pdfId]: list.filter(n => n.id !== noteId),
      },
    }
  })
}

export function clearNotesForPdf(pdfId: string): void {
  useNotesStore.setState(state => {
    const { [pdfId]: _dropped, ...rest } = state.notesByPdf
    return { notesByPdf: rest }
  })
}

export function setActiveKind(kind: NoteKind | null): void {
  useNotesStore.setState(state => {
    if (kind === null) return { activeKind: null }
    // When switching kinds, reset the color to that kind's default unless the
    // user has already picked a custom color for this session.
    const nextColor =
      state.activeKind === kind ? state.activeColor : DEFAULT_COLOR_BY_KIND[kind]
    return { activeKind: kind, activeColor: nextColor }
  })
}

export function setActiveColor(color: string): void {
  useNotesStore.setState({ activeColor: color })
}
