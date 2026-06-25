// Koine Studio shell layout persistence: two-group editor split, orientation, panel placement,
// and side-rail position, all backed by localStorage. Pure data — no DOM, no signals.
// Every read is guarded against absent storage and malformed JSON so a corrupt key never breaks
// the app; every write is best-effort and swallows quota/security errors.

// --- model -------------------------------------------------------------------

export interface LayoutState {
  /** Whether the editor area is split into two groups (A + B). */
  splitOpen: boolean;
  /** How the two editor groups are divided when split is open. */
  orientation: 'horizontal' | 'vertical';
  /** Which edge the bottom/auxiliary panel docks to. */
  panelSide: 'bottom' | 'right';
  /** Which side the collapsible file-explorer rail lives on. */
  sideRail: 'left' | 'right';
  /** Active file URIs for group A (always present) and group B (only meaningful when split is open). */
  groupActiveUris: [string, string?];
}

export const DEFAULT_LAYOUT: LayoutState = {
  splitOpen: false,
  orientation: 'horizontal',
  panelSide: 'bottom',
  sideRail: 'right',
  groupActiveUris: ['', undefined],
};

// --- storage key -------------------------------------------------------------

const LAYOUT_KEY = 'koine.studio.layout';

// --- raw localStorage helpers (never throw) ----------------------------------

/** Read a key, returning null on any error or when storage is unavailable. */
function readRaw(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Write a key, swallowing quota/security errors. */
function writeRaw(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // storage unavailable or full — best effort only
  }
}

// --- per-field coercions -----------------------------------------------------

function coerceSplitOpen(v: unknown): boolean {
  return typeof v === 'boolean' ? v : DEFAULT_LAYOUT.splitOpen;
}

function coerceOrientation(v: unknown): LayoutState['orientation'] {
  return v === 'horizontal' || v === 'vertical' ? v : DEFAULT_LAYOUT.orientation;
}

function coercePanelSide(v: unknown): LayoutState['panelSide'] {
  return v === 'bottom' || v === 'right' ? v : DEFAULT_LAYOUT.panelSide;
}

function coerceSideRail(v: unknown): LayoutState['sideRail'] {
  return v === 'left' || v === 'right' ? v : DEFAULT_LAYOUT.sideRail;
}

function coerceGroupActiveUris(v: unknown): LayoutState['groupActiveUris'] {
  if (!Array.isArray(v)) return [...DEFAULT_LAYOUT.groupActiveUris];
  const a = typeof v[0] === 'string' ? v[0] : '';
  const b = typeof v[1] === 'string' ? v[1] : undefined;
  return [a, b];
}

// --- public API --------------------------------------------------------------

/**
 * Load the persisted layout state. Unknown shapes, bad JSON, and absent storage all fall
 * back to the defaults. Each enum field is coerced individually so a single hand-edited
 * value can't corrupt the whole state.
 */
export function loadLayout(): LayoutState {
  const raw = readRaw(LAYOUT_KEY);
  if (raw === null) return { ...DEFAULT_LAYOUT };
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ...DEFAULT_LAYOUT };
    }
    return {
      splitOpen: coerceSplitOpen(parsed.splitOpen),
      orientation: coerceOrientation(parsed.orientation),
      panelSide: coercePanelSide(parsed.panelSide),
      sideRail: coerceSideRail(parsed.sideRail),
      groupActiveUris: coerceGroupActiveUris(parsed.groupActiveUris),
    };
  } catch {
    return { ...DEFAULT_LAYOUT };
  }
}

/**
 * Merge a partial patch onto the current layout, persist, and return the merged result.
 * Unknown shapes in localStorage fall back to defaults before the patch is applied, so
 * a corrupt key is self-healing on the next save.
 */
export function saveLayout(patch: Partial<LayoutState>): LayoutState {
  const merged: LayoutState = { ...loadLayout(), ...patch };
  writeRaw(LAYOUT_KEY, JSON.stringify(merged));
  return merged;
}
