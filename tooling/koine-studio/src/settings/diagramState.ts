// Diagram canvas state (issue #988): per-diagram zoom, node positions (authoring canvas), and
// canvas-only annotations (notes + groups). All three are a VIEW concern only — they never round-trip
// into `.koi` (the compiler is the source of truth for the model; localStorage is the right home).
// Split out of persistence.ts, which now re-exports this module's public surface via
// `export * from './diagramState'` so `@/settings/persistence` stays the unchanged import path for
// every existing caller.

import {
  clampZoomPercent,
  sanitizeGroups,
  sanitizeNotes,
  type DiagramGroup,
  type DiagramNote,
  type DiagramPosition,
} from '@/diagrams/diagramContract';
import { readRaw, writeRaw } from '@/shell/storage';
import { removeKey } from './storage';

// --- diagram canvas zoom (#145) ----------------------------------------------
// Each diagram's last zoom *percent* is round-tripped under its own key so the interactive canvas can
// restore it next time the Diagrams tab opens. Only the zoom is remembered (not the pan), matching the
// plan: a tab re-open re-fits and re-centers but keeps the magnification the user chose. Values are
// clamped on both read and write so a malformed/hand-edited key can never feed the layout a bad number.
const DIAGRAM_ZOOM_KEY_PREFIX = 'koine.studio.diagramZoom.';
// The zoom band (DIAGRAM_ZOOM_MIN/MAX) and its clamp (clampZoomPercent) are owned by diagramContract and
// imported above, so this layer and the renderer clamp to the SAME band with a one-way dependency.

/** The persisted zoom percent for a diagram key, or null when none is stored (or it's malformed). */
export function loadDiagramZoom(key: string): number | null {
  const raw = readRaw(DIAGRAM_ZOOM_KEY_PREFIX + key);
  return raw == null ? null : clampZoomPercent(Number(raw));
}

/** Persist a diagram's zoom percent (best-effort), clamped to the sane band. */
export function saveDiagramZoom(key: string, percent: number): void {
  const z = clampZoomPercent(percent);
  if (z == null) return;
  writeRaw(DIAGRAM_ZOOM_KEY_PREFIX + key, String(Math.round(z)));
}

// --- diagram node positions (authoring canvas) -------------------------------
// The authoring canvas lets the user drag nodes anywhere (n8n-style) and remembers where they left each
// one, keyed PER WORKSPACE + diagram so positions never bleed across projects. Positions are a VIEW
// concern only — they never round-trip into `.koi` (the compiler is the source of truth for the model;
// localStorage is the right home, exactly like zoom). Keyed by a node's stable qualified name so a layout
// survives a re-render (and most model edits). Every read is guarded so a hand-edited key can't break the
// canvas, and malformed entries are dropped individually.
const DIAGRAM_POSITIONS_KEY_PREFIX = 'koine.studio.diagramPositions.';

/** The persisted node positions for a diagram key, keyed by qualified name; {} when absent/malformed. */
export function loadDiagramPositions(key: string): Record<string, DiagramPosition> {
  const raw = readRaw(DIAGRAM_POSITIONS_KEY_PREFIX + key);
  if (raw === null) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, DiagramPosition> = {};
    for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (value && typeof value === 'object') {
        const p = value as Record<string, unknown>;
        if (typeof p.x === 'number' && Number.isFinite(p.x) && typeof p.y === 'number' && Number.isFinite(p.y)) {
          out[name] = { x: p.x, y: p.y };
        }
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** Persist a diagram's node positions (best-effort). */
export function saveDiagramPositions(key: string, positions: Record<string, DiagramPosition>): void {
  writeRaw(DIAGRAM_POSITIONS_KEY_PREFIX + key, JSON.stringify(positions));
}

/** Forget a diagram's saved positions (the "Auto-arrange / reset layout" action). */
export function clearDiagramPositions(key: string): void {
  removeKey(DIAGRAM_POSITIONS_KEY_PREFIX + key);
}

// --- diagram canvas annotations (notes + groups, #255) -----------------------
// Canvas-only annotations (free-text notes and node groupings) are a VIEW concern exactly like positions
// above — they never round-trip into `.koi`. In browser/scratch mode they live in localStorage under a
// sibling key (positions keep their own key, so the position storage stays backward-compatible); in folder
// mode the committable koine.layout.json holds both (see layoutStore.ts). Every read is guarded and
// malformed entries are dropped individually (shared sanitizers), so a hand-edited key can't break the canvas.
const DIAGRAM_ANNOTATIONS_KEY_PREFIX = 'koine.studio.diagramAnnotations.';

/** The canvas-only annotations for a diagram: free-text notes plus node groupings. */
export interface DiagramAnnotations {
  notes: DiagramNote[];
  groups: DiagramGroup[];
}

/** The persisted annotations for a diagram key; empty notes/groups when absent or malformed. */
export function loadDiagramAnnotations(key: string): DiagramAnnotations {
  const raw = readRaw(DIAGRAM_ANNOTATIONS_KEY_PREFIX + key);
  if (raw === null) return { notes: [], groups: [] };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object') return { notes: [], groups: [] };
    const p = parsed as Record<string, unknown>;
    return { notes: sanitizeNotes(p.notes), groups: sanitizeGroups(p.groups) };
  } catch {
    return { notes: [], groups: [] };
  }
}

/** Persist a diagram's canvas annotations (best-effort). */
export function saveDiagramAnnotations(key: string, annotations: DiagramAnnotations): void {
  writeRaw(
    DIAGRAM_ANNOTATIONS_KEY_PREFIX + key,
    JSON.stringify({ notes: annotations.notes, groups: annotations.groups }),
  );
}
