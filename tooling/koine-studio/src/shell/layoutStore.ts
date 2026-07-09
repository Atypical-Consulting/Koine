// Koine Studio shell layout persistence: two-group editor split, orientation, panel placement,
// and side-rail position, all backed by localStorage. Pure data — no DOM, no signals.
// Every read is guarded against absent storage and malformed JSON so a corrupt key never breaks
// the app; every write is best-effort and swallows quota/security errors.
import { readRaw, writeRaw } from '@/shell/storage';

// --- model -------------------------------------------------------------------

export interface LayoutState {
  /** Which edge the bottom/auxiliary panel docks to. */
  panelSide: 'bottom' | 'right';
  /** Which side the collapsible file-explorer rail lives on. */
  sideRail: 'left' | 'right';
  /** Whether the desktop right Properties rail is collapsed (reclaiming its column). The right-edge
   *  tool-window stripe stays docked; re-expanding restores the last active `RightView`. Desktop-only.
   *  Defaults to collapsed (#730): inspection is contextual, so a fresh workspace starts with the rail
   *  tucked and reveal-on-select brings Properties out the moment an element is selected. */
  rightCollapsed: boolean;
  /** Whether the left navigator rail is collapsed to its icon spine. Defaults OPEN (#730): navigation is
   *  persistent — you orient against the tree constantly — so the spine is an on-demand reclaim, not a
   *  calm default like `rightCollapsed`. Desktop-only. */
  leftCollapsed: boolean;
}

export const DEFAULT_LAYOUT: LayoutState = {
  panelSide: 'bottom',
  sideRail: 'right',
  rightCollapsed: true,
  leftCollapsed: false,
};

// --- storage key -------------------------------------------------------------

const LAYOUT_KEY = 'koine.studio.layout';

// --- per-field coercions -----------------------------------------------------

function coercePanelSide(v: unknown): LayoutState['panelSide'] {
  return v === 'bottom' || v === 'right' ? v : DEFAULT_LAYOUT.panelSide;
}

function coerceSideRail(v: unknown): LayoutState['sideRail'] {
  return v === 'left' || v === 'right' ? v : DEFAULT_LAYOUT.sideRail;
}

function coerceRightCollapsed(v: unknown): boolean {
  return typeof v === 'boolean' ? v : DEFAULT_LAYOUT.rightCollapsed;
}

function coerceLeftCollapsed(v: unknown): boolean {
  return typeof v === 'boolean' ? v : DEFAULT_LAYOUT.leftCollapsed;
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
      panelSide: coercePanelSide(parsed.panelSide),
      sideRail: coerceSideRail(parsed.sideRail),
      rightCollapsed: coerceRightCollapsed(parsed.rightCollapsed),
      leftCollapsed: coerceLeftCollapsed(parsed.leftCollapsed),
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
