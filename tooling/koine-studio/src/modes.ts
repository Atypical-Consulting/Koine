// Koine Studio workspace modes (#143): a header-level grouping of the right inspector's views into a
// few task-oriented modes (Domain / Code / Docs). Pure data + lookups — no DOM, no persistence — so
// the toolbar switcher (ide.ts) and the store (store.ts) build on ONE source of truth, and per-mode
// layout presets stay a clean future follow-up. Modelling modes as data is also why a fourth "Tests"
// mode (in the issue title) is a future addition rather than a rewrite.

/**
 * The right inspector's tab views. Owned here — rather than in ide.ts — because the mode model is the
 * single source of truth for the view roster AND how it partitions into modes; ide.ts imports it.
 */
export type RightView =
  | 'preview'
  | 'model'
  | 'glossary'
  | 'diagrams'
  | 'contextmap'
  | 'outline'
  | 'assistant'
  | 'check';

/** A top-level workspace mode: a labelled group of inspector views with a default landing view. */
export interface WorkspaceMode {
  /** Stable id — persisted to storage and embedded in palette command ids. */
  id: string;
  /** Human label shown on the header switcher button. */
  label: string;
  /** The views this mode surfaces, in tab order. */
  views: RightView[];
  /** The view selected when entering the mode (always one of `views`). */
  defaultView: RightView;
}

/**
 * The mode roster. The view sets are a disjoint partition of every {@link RightView}, so each view
 * belongs to exactly one mode and {@link modeForView} is unambiguous. Assistant and Check live in a
 * mode for that totality but stay reachable regardless of the active mode — Check via its toolbar
 * button and the palette, Assistant via the palette ("Show Assistant" / "Explain this construct").
 */
export const MODES: readonly WorkspaceMode[] = [
  { id: 'domain', label: 'Domain', views: ['outline', 'model', 'diagrams', 'contextmap'], defaultView: 'outline' },
  { id: 'code', label: 'Code', views: ['preview', 'check'], defaultView: 'preview' },
  { id: 'docs', label: 'Docs', views: ['glossary', 'assistant'], defaultView: 'glossary' },
];

/** The mode shown on first run and whenever a persisted/restored id is absent or invalid. */
export const DEFAULT_MODE_ID = 'domain';

/** The default mode object — never undefined, since DEFAULT_MODE_ID always names a real mode. */
function defaultMode(): WorkspaceMode {
  return MODES.find((m) => m.id === DEFAULT_MODE_ID) ?? MODES[0];
}

/** True when `id` names a real mode — used to validate a restored value before trusting it. */
export function isValidModeId(id: string): boolean {
  return MODES.some((m) => m.id === id);
}

/** The views for a mode, in tab order (a copy, so callers can't mutate the shared roster). Unknown id → default mode. */
export function viewsForMode(id: string): RightView[] {
  return [...(MODES.find((m) => m.id === id) ?? defaultMode()).views];
}

/** The landing view for a mode. Unknown id → the default mode's landing view. */
export function defaultViewForMode(id: string): RightView {
  return (MODES.find((m) => m.id === id) ?? defaultMode()).defaultView;
}

/** The id of the mode that owns a view. Unknown view → {@link DEFAULT_MODE_ID} (defensive). */
export function modeForView(view: RightView): string {
  return (MODES.find((m) => m.views.includes(view)) ?? defaultMode()).id;
}
