// Renders notes (highlights + callouts) over a single PDF page, parallel to
// the existing source-rectangle overlay. Also owns the draw-rect gesture for
// callout creation; highlight creation lives in ParsingPage because selections
// can span pages.

import { useRef, useState } from 'react'
import type { Note, NoteKind } from '../../stores/notes-store'
import { DEFAULT_CALLOUT_FONT_SIZE } from '../../stores/notes-store'
import { SCALE } from '../../pdf/types'
import styles from './ParsingPage.module.css'

interface Props {
  notes: Note[]
  scale: number
  activeKind: NoteKind | null
  activeColor: string
  // Width/height of the page at natural (SCALE) pixel resolution, before the
  // user zoom factor. Used to clamp callout draws.
  pageWidth: number
  pageHeight: number
  onCreateCallout: (bbox: { x0: number; y0: number; x1: number; y1: number }) => void
  onSelectNote: (noteId: string) => void
  selectedNoteId: string | null
}

interface DrawState {
  startX: number
  startY: number
  currentX: number
  currentY: number
}

export function NotesLayer({
  notes,
  scale,
  activeKind,
  activeColor,
  pageWidth,
  pageHeight,
  onCreateCallout,
  onSelectNote,
  selectedNoteId,
}: Props) {
  const [drawing, setDrawing] = useState<DrawState | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)

  const onMouseDown = (e: React.MouseEvent) => {
    if (activeKind !== 'callout') return
    if (e.button !== 0) return
    const container = containerRef.current
    if (!container) return
    e.preventDefault()
    e.stopPropagation()
    const rect = container.getBoundingClientRect()
    const x = (e.clientX - rect.left) / scale
    const y = (e.clientY - rect.top) / scale
    setDrawing({ startX: x, startY: y, currentX: x, currentY: y })
  }

  const onMouseMove = (e: React.MouseEvent) => {
    if (!drawing) return
    const container = containerRef.current
    if (!container) return
    const rect = container.getBoundingClientRect()
    const x = Math.max(0, Math.min(pageWidth, (e.clientX - rect.left) / scale))
    const y = Math.max(0, Math.min(pageHeight, (e.clientY - rect.top) / scale))
    setDrawing({ ...drawing, currentX: x, currentY: y })
  }

  const onMouseUp = () => {
    if (!drawing) return
    const x0 = Math.min(drawing.startX, drawing.currentX)
    const y0 = Math.min(drawing.startY, drawing.currentY)
    const x1 = Math.max(drawing.startX, drawing.currentX)
    const y1 = Math.max(drawing.startY, drawing.currentY)
    setDrawing(null)
    // Minimum callout area; a missed click shouldn't spawn one.
    if (x1 - x0 < 8 || y1 - y0 < 8) return
    onCreateCallout({ x0, y0, x1, y1 })
  }

  const showDrawPreview = drawing !== null
  const drawStyle = drawing
    ? {
        left: Math.min(drawing.startX, drawing.currentX) * scale,
        top: Math.min(drawing.startY, drawing.currentY) * scale,
        width: Math.abs(drawing.currentX - drawing.startX) * scale,
        height: Math.abs(drawing.currentY - drawing.startY) * scale,
      }
    : undefined

  return (
    <div
      ref={containerRef}
      className={styles['notes-layer']}
      style={{
        position: 'absolute',
        inset: 0,
        // Callout mode needs pointer events to draw; other modes pass clicks
        // through to the underlying text layer so the user can still select
        // text (for highlights) or interact with source rects.
        pointerEvents: activeKind === 'callout' ? 'auto' : 'none',
        cursor: activeKind === 'callout' ? 'crosshair' : 'default',
      }}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={() => setDrawing(null)}
    >
      {notes.map(note => renderNote(note, scale, onSelectNote, selectedNoteId))}
      {showDrawPreview && drawStyle && (
        <div
          className={styles['notes-draw-preview']}
          style={{
            position: 'absolute',
            ...drawStyle,
            border: `2px dashed ${activeColor}`,
            background: `${activeColor}40`,
            pointerEvents: 'none',
          }}
        />
      )}
    </div>
  )
}

function renderNote(
  note: Note,
  scale: number,
  onSelectNote: (id: string) => void,
  selectedNoteId: string | null
) {
  const selected = note.id === selectedNoteId
  const common = {
    onMouseDown: (e: React.MouseEvent) => {
      e.stopPropagation()
      onSelectNote(note.id)
    },
    pointerEvents: 'auto' as const,
  }

  if (note.kind === 'highlight') {
    const quads = note.quads && note.quads.length > 0 ? note.quads : [note.bbox]
    return (
      <span key={note.id} title={note.text || '(highlight)'}>
        {quads.map((q, i) => (
          <div
            key={`${note.id}_${i}`}
            style={{
              position: 'absolute',
              left: q.x0 * scale,
              top: q.y0 * scale,
              width: (q.x1 - q.x0) * scale,
              height: (q.y1 - q.y0) * scale,
              background: note.color,
              opacity: 0.4,
              mixBlendMode: 'multiply',
              outline: selected ? '1px solid #1f2937' : undefined,
              ...common,
            }}
            onMouseDown={common.onMouseDown}
          />
        ))}
      </span>
    )
  }

  // Callout
  //
  // Match the exporter's visual: font size is in PDF points, and the PDF is
  // rendered at SCALE pixels-per-point, so the on-screen size has to account
  // for SCALE and the user's zoom factor to line up with what pdf-lib draws.
  const fontSizePt = note.fontSize ?? DEFAULT_CALLOUT_FONT_SIZE
  const fontSizePx = fontSizePt * SCALE * scale
  return (
    <div
      key={note.id}
      title={note.text || '(callout)'}
      style={{
        position: 'absolute',
        left: note.bbox.x0 * scale,
        top: note.bbox.y0 * scale,
        width: (note.bbox.x1 - note.bbox.x0) * scale,
        height: (note.bbox.y1 - note.bbox.y0) * scale,
        background: `${note.color}8C`, // ~55% opacity, matches exporter
        border: `1px solid ${note.color}`,
        borderRadius: 4,
        padding: 4 * scale,
        fontSize: fontSizePx,
        fontFamily: 'Helvetica, Arial, sans-serif',
        fontWeight: note.bold ? 700 : 400,
        lineHeight: 1.2,
        color: '#13151f', // matches exporter near-black
        overflow: 'hidden',
        whiteSpace: 'pre-wrap', // honours user-inserted newlines
        wordBreak: 'break-word',
        outline: selected ? '2px solid #1f2937' : undefined,
        ...common,
      }}
      onMouseDown={common.onMouseDown}
    >
      {note.text || ''}
    </div>
  )
}
