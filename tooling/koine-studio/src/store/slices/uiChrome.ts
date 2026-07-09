import type { StoreApi } from 'zustand/vanilla';
import type { RightStripView } from '@atypical/koine-ui';
// TYPE-ONLY: persistence.ts imports runtime from this slice, so a value import would cycle; a type
// import is erased at build time and safe.
import type { ThemeName } from '@/settings/persistence';
// TYPE-ONLY, and settingsTypes.ts is itself import-free: settingsPage.tsx also imports from here, so
// this is the single shared definition of the two unions below rather than a second inlined copy (#1094).
import type { SettingsEditorMode, SettingsJsonScope } from '@/settings/settingsTypes';

export type CenterView = 'visual' | 'technical' | 'output' | 'docs';
// Code is authoring-only now: the editor + the scenario runner. The compiler-PRODUCED artifacts
// (emitted code, compatibility, the context map) moved to their own 'output' center view below.
export type TechView = 'editor' | 'scenarios';
// Output groups what the compiler produces from the model: the emitted source ('generated'), the
// model-versioning check ('compatibility'), and the context map (relocated from the bottom panel).
export type OutputTab = 'generated' | 'compatibility' | 'contextmap';
export type DocsView = 'glossary' | 'adr' | 'notes';
export type BottomTab = 'problems' | 'events' | 'relationships' | 'terminal' | 'review';
// The AI assistant docks in the right rail (a RightView), not the center — it can stay open beside
// Code/Canvas while you work, rather than competing for the main stage as a center tab. (Rules + Notes
// were retired in #730: invariants show in Properties, Notes lives in the Deck's Docs surface.)
export type RightView = 'props' | 'assistant' | 'source-control' | 'syntax-tree';
// Compile-time proof RightView and koine-ui's RightStripView (the right-strip's rendered button set) stay
// in lockstep: the right-strip switcher reads `data-rview` values the JSX emits, so a divergence between the
// two unions would silently drop a switcher. The tuple annotation forces both `extends` directions to
// resolve to `true`; if either stops holding, its alias becomes `never`, `[true, true]` no longer fits the
// annotation, and tsc fails. The inert const + `void` is the idiomatic static-assert anchor — it has no
// runtime effect (and the production bundle tree-shakes it), while keeping the type aliases "used" so the
// no-unused-locals gate stays green.
type _RVtoStrip = RightView extends RightStripView ? true : never;
type _StripToRV = RightStripView extends RightView ? true : never;
const _rightViewContract: [_RVtoStrip, _StripToRV] = [true, true];
void _rightViewContract;

/** The four zones the narrow-viewport (mobile) shell shows one at a time, switched by the bottom
 *  MobileZoneBar. Code → #center + selectCenter('technical'); Diagram → #center + selectCenter('visual');
 *  Files → #leftrail; Props → #right. Desktop ignores this (the five-track grid shows all panes). */
export type MobileZone = 'files' | 'code' | 'diagram' | 'props';

/** The center pane shown on first run and whenever a persisted/restored value is absent or invalid. */
export const DEFAULT_CENTER: CenterView = 'visual';

/** The Output sub-view shown first — the emitted source, the most-used compiler artifact. */
export const DEFAULT_OUTPUT: OutputTab = 'generated';

/** The zone the mobile shell opens on — Code, so a phone lands on the editor (the primary review surface). */
export const DEFAULT_MOBILE_ZONE: MobileZone = 'code';

/** True when `v` names a real center pane — validates a restored value before trusting it.
 *  (A persisted `'assistant'` from before the AI moved to the right rail fails this and falls back
 *  to the default, which is the intended graceful migration.) */
export function isValidCenter(v: string): v is CenterView {
  return v === 'visual' || v === 'technical' || v === 'output' || v === 'docs';
}

/** True when `v` names a real mobile zone — validates a restored/external value before trusting it. */
export function isValidMobileZone(v: string): v is MobileZone {
  return v === 'files' || v === 'code' || v === 'diagram' || v === 'props';
}

// --- Center deck (Deck v2 layout model) ---

/** Focus = 1-up or 2-up live editing; overview = the 2×2 bird's-eye of all four surfaces. */
export type DeckMode = 'focus' | 'overview';

/** The Deck v2 center-layout model. The four center surfaces are cards on a stage:
 *  - `primary` is the SELECTED surface — always visible, and mirrored to the legacy `center` field.
 *  - `secondary` is the comparison surface in a 2-up, or `null` for a 1-up.
 *  - `ratio` is the LEFT pane's width fraction in a 2-up (clamped to [{@link DECK_RATIO_MIN},
 *    {@link DECK_RATIO_MAX}]).
 *  - `flipped` swaps which SIDE (left/right) the primary sits on, without changing the selection.
 *  - `mode` toggles the bird's-eye overview (all four cards in a 2×2). */
export interface DeckState {
  mode: DeckMode;
  primary: CenterView;
  secondary: CenterView | null;
  ratio: number;
  flipped: boolean;
}

/** The 2-up seam's left-pane fraction is clamped to this band so neither pane collapses. */
export const DECK_RATIO_MIN = 0.2;
export const DECK_RATIO_MAX = 0.8;

const clampRatio = (r: number): number => Math.min(DECK_RATIO_MAX, Math.max(DECK_RATIO_MIN, r));

/** The single-surface default — Canvas, full (equivalent to the pre-deck `center: 'visual'`). */
export const DEFAULT_DECK_STATE: DeckState = {
  mode: 'focus',
  primary: 'visual',
  secondary: null,
  ratio: 0.5,
  flipped: false,
};

/** True when `v` is a well-formed {@link DeckState} — validates a persisted/restored value. */
export function isValidDeckState(v: unknown): v is DeckState {
  if (!v || typeof v !== 'object') return false;
  const d = v as DeckState;
  if (d.mode !== 'focus' && d.mode !== 'overview') return false;
  if (!isValidCenter(d.primary)) return false;
  if (d.secondary !== null && !isValidCenter(d.secondary)) return false;
  if (d.secondary === d.primary) return false; // a surface can't be both panes
  if (typeof d.ratio !== 'number' || !Number.isFinite(d.ratio) || d.ratio <= 0 || d.ratio >= 1) return false;
  if (typeof d.flipped !== 'boolean') return false;
  return true;
}

/** Which top-level navigator the left rail shows (#453): the strategic/tactical Domain pane or the
 *  workspace Files tree. */
export type RailAxis = 'domain' | 'files';

/** The Context Map's rendered view (#983): the interactive graph or the dense per-relation table. */
export type ContextMapView = 'graph' | 'table';

/** Which edge the bottom/auxiliary panel docks to (#983). Inlined here (not imported from layoutStore)
 *  so the slice stays self-contained; structurally identical to `LayoutState['panelSide']`. */
export type PanelSide = 'bottom' | 'right';

/** Which side the collapsible file-explorer/inspector side rail lives on (#983). Inlined for the same
 *  no-cycle reason as {@link PanelSide}; structurally identical to `LayoutState['sideRail']`. */
export type SideRail = 'left' | 'right';

/** The left rail opens on the Domain navigator — the strategic/tactical DDD view is the primary lens. */
export const DEFAULT_RAIL_AXIS: RailAxis = 'domain';

/** The Context Map opens as the interactive graph; the table stays one click away. */
export const DEFAULT_CONTEXT_MAP_VIEW: ContextMapView = 'graph';

/** The Settings page opens on the Visual form; the raw settings.json is one toggle away. */
export const DEFAULT_SETTINGS_EDITOR_MODE: SettingsEditorMode = 'visual';

/** The Settings JSON editor targets the user document by default (workspace needs a folder open). */
export const DEFAULT_SETTINGS_JSON_SCOPE: SettingsJsonScope = 'user';

/** The bottom panel docks to the bottom edge by default. MUST match `DEFAULT_LAYOUT.panelSide`. */
export const DEFAULT_PANEL_SIDE: PanelSide = 'bottom';

/** The side rail (inspector) lives on the right by default. MUST match `DEFAULT_LAYOUT.sideRail`. */
export const DEFAULT_SIDE_RAIL: SideRail = 'right';

export interface UiChromeSlice {
  center: CenterView;
  tech: TechView;
  output: OutputTab;
  docs: DocsView;
  bottom: BottomTab;
  right: RightView;
  /** Whether the desktop right Properties rail is collapsed. Runtime source of truth, mirrored to
   *  `layoutStore` for persistence (#193: the slice owns chrome state, not the DOM). Independent of
   *  `right` — collapsing remembers the last active view, so re-expanding restores it. */
  rightCollapsed: boolean;
  /** Whether the left navigator rail is collapsed to its icon spine (reclaiming most of its column).
   *  Mirrored to `layoutStore` for persistence, like `rightCollapsed`. Navigation is persistent, so this
   *  defaults open — the spine is an on-demand way to reclaim the rail's width, not a calm-default tuck. */
  leftCollapsed: boolean;
  /** The active mobile zone (single source of truth for the narrow-viewport shell). ide.tsx mirrors it
   *  to #split[data-mobile-zone] so the @media rules show/hide zones; the MobileZoneBar reads + writes it. */
  mobileZone: MobileZone;
  /** Which top-level navigator the left rail shows (#453). Runtime source of truth (#193/#983);
   *  inspectorController mirrors it to `koine.studio.railAxis` for persistence, like the collapse flags. */
  railAxis: RailAxis;
  /** Whether the bottom diagnostics strip is collapsed. RUNTIME source of truth (#983 — was the DOM
   *  `.collapsed` class): the chevron, the #475 viewport default, and the tab-click auto-expand all flow
   *  through this, so every read (the chevron toggle target, the live-refresh gate) trusts the slice. */
  diagCollapsed: boolean;
  /** The user's EXPLICIT collapse choice for the bottom strip, or `null` when unset. `null` lets the #475
   *  viewport-aware default apply; a non-null value is what inspectorController persists to
   *  `koine.studio.diagCollapsed` ('1'/'0') and always wins over the default. Only {@link setDiagCollapsed}
   *  records it — the default and the transient tab-click reveal never touch it, so they never persist. */
  diagCollapsedPref: boolean | null;
  /** The Context Map's rendered view (#983). Runtime source of truth; inspectorController mirrors it to
   *  `koine.studio.contextMapView` for persistence and repaints the panel on a change. */
  contextMapView: ContextMapView;
  /** Which edge the bottom panel docks to (#983). Runtime source of truth, mirrored to `layoutStore`
   *  for persistence like the collapse flags; the layout controller subscribes and repaints
   *  #split[data-panel-side]. */
  panelSide: PanelSide;
  /** Which side the inspector side rail lives on (#983). Runtime source of truth, mirrored to
   *  `layoutStore` for persistence; the layout controller subscribes, repaints #split[data-siderail-side]
   *  and re-anchors the edge resizers on a change. */
  sideRail: SideRail;
  /** The active UI theme (#983). Runtime source of truth for what was `theme.ts`'s module-local `active`;
   *  `applyTheme`/`setTheme` publish here and `currentTheme()` reads it, so the theme fan-out (diagrams +
   *  terminal re-theme) is a plain store subscription instead of a bespoke listener Set. Persistence stays
   *  in `Settings.theme` (via `patchSettings`). */
  theme: ThemeName;
  /** The Explorer outline's type-to-filter query. Lives in the store (not panel-local state) because the
   *  controller unmounts + remounts the outline panel on every model reload, which would otherwise wipe a
   *  component-local query mid-task; here it survives the remount. */
  outlineFilter: string;
  /** The workspace file Explorer's type-to-filter query (#989 task 7) — the SAME rationale as
   *  {@link outlineFilter}: `ExplorerPanel` is remounted on a workspace reload, which would otherwise wipe
   *  a component-local query mid-task; here it survives the remount. Runtime-only (not persisted), like
   *  `outlineFilter`. */
  explorerFilter: string;
  /** The set of collapsed directory tokens in the workspace Explorer (#989 task 7), as a plain array (not
   *  a `Set`) so the store stays a serializable-shaped value — `ExplorerPanel` converts to/from a `Set`
   *  locally wherever `Set` operations are more convenient. Lifted into the store for the same reason as
   *  {@link explorerFilter}: it must survive an `ExplorerPanel` remount. Runtime-only (not persisted) — the
   *  collapsed set is not restored across a page reload, only across a same-session panel remount. */
  explorerCollapsed: readonly string[];
  /** The Deck v2 center layout. The legacy `center` field mirrors `deck.primary`. */
  deck: DeckState;
  /** Whether the transient, gear-launched Settings overlay (#482) is showing OVER the deck. Orthogonal
   *  to the deck (Settings is not a surface): never persisted/restored, and cleared by focusing any deck
   *  surface, so it can't leak into the saved center/deck. */
  settingsOpen: boolean;
  /** The category the Settings overlay should land on when opened (#731) — a prefs.ts category id
   *  (`appearance | editor | keyboard | output | assistant | mcp | advanced | about`), or `null` to open
   *  on the pane's last-used / default tab. Set by `showSettings(category?)`; read by the host that mounts
   *  the preferences pane. Like `settingsOpen`, it's transient and never persisted. */
  settingsCategory: string | null;
  /** The Settings page's active representation (#983). Runtime home for what was a `settingsPage.tsx`
   *  closure; the page seeds this from persistence and writes `koine.studio.settingsEditorMode`
   *  imperatively (the page is transient, so persistence stays local, not a subscriber). */
  settingsEditorMode: SettingsEditorMode;
  /** The Settings JSON editor's active scope (#983). Runtime home for the page's `scope` closure; the
   *  page seeds it per the wsKey rule and persists `koine.studio.settingsJsonScope` imperatively. */
  settingsJsonScope: SettingsJsonScope;
  setCenter(v: CenterView): void;
  setTech(v: TechView): void;
  setOutput(v: OutputTab): void;
  setDocs(v: DocsView): void;
  setBottom(t: BottomTab): void;
  setRight(v: RightView): void;
  setRightCollapsed(v: boolean): void;
  toggleRightCollapsed(): void;
  setLeftCollapsed(v: boolean): void;
  toggleLeftCollapsed(): void;
  setOutlineFilter(q: string): void;
  /** Replace the Explorer filter text wholesale (#989 task 7) — mirrors {@link setOutlineFilter}. */
  setExplorerFilter(q: string): void;
  /** Flip one token's membership in the Explorer's collapsed-directories set (#989 task 7): adds it if
   *  absent, removes it if present. What a directory row's click toggles. */
  toggleExplorerCollapsed(token: string): void;
  /** REPLACE the whole Explorer collapsed-directories set with exactly `tokens` (#989 task 7) — used by
   *  "Collapse all" (sets every directory token at once) and by collapsed-set pruning against a fresh
   *  `liveDirs` (a directory deleted/renamed/moved away must drop out, not linger forever). */
  setExplorerCollapsedMany(tokens: readonly string[]): void;
  /** REMOVE exactly `tokens` from the Explorer's collapsed-directories set (#989 task 7) — used by
   *  "Expand all" (removes every directory token) and by reveal-by-context ancestor expansion. */
  expandExplorerTokens(tokens: readonly string[]): void;
  setMobileZone(z: MobileZone): void;
  setRailAxis(v: RailAxis): void;
  /** Record an EXPLICIT collapse choice for the bottom strip: sets BOTH the runtime flag and the
   *  persisted preference (so it wins over the #475 default and inspectorController persists it). */
  setDiagCollapsed(v: boolean): void;
  /** Apply the viewport-aware DEFAULT collapse state (#475) — RUNTIME-ONLY, and a NO-OP once the user has
   *  an explicit preference (`diagCollapsedPref !== null`), so a saved choice is never overridden. */
  applyDiagCollapsedDefault(v: boolean): void;
  setContextMapView(v: ContextMapView): void;
  setPanelSide(v: PanelSide): void;
  /** Flip the bottom panel's dock edge (bottom↔right), like `toggleRightCollapsed` flips its flag. */
  togglePanelSide(): void;
  setSideRail(v: SideRail): void;
  /** Flip the side rail's side (right↔left), like `toggleLeftCollapsed` flips its flag. */
  toggleSideRail(): void;
  /** Publish the active theme (#983). Called by `theme.ts`'s `applyTheme`; the DOM apply + persistence
   *  stay in `theme.ts`, this only mirrors the value so subscribers can react. */
  setTheme(v: ThemeName): void;
  setSettingsEditorMode(v: SettingsEditorMode): void;
  setSettingsJsonScope(v: SettingsJsonScope): void;
  /** Replace the whole deck state (used by restore/persistence). Keeps `center` in sync. */
  setDeck(deck: DeckState): void;
  /** Focus a surface 1-up — collapses any 2-up and leaves overview. Mirrors `center`. */
  focusPrimary(view: CenterView): void;
  /** Toggle a second surface beside the primary (the Lens-style "open beside"). No-op for the
   *  primary itself; a fresh second pane always opens on the right (flipped reset). */
  openBeside(view: CenterView): void;
  /** Close a surface: drops the secondary, or — when closing the primary in a 2-up — promotes the
   *  secondary to primary. No-op on the sole surface or a surface that isn't shown. */
  closeSurface(view: CenterView): void;
  /** Swap the two panes' left/right positions; the selection (primary) is unchanged. */
  swapSides(): void;
  /** Select the OTHER pane in a 2-up (promote it to primary) WITHOUT moving either pane —
   *  `flipped` is compensated so the geometry is unchanged, only the active-pane chrome updates. */
  selectPane(view: CenterView): void;
  /** Set the 2-up seam position (left-pane width fraction, clamped to the ratio band). */
  setRatio(ratio: number): void;
  /** Enter or leave the 2×2 bird's-eye overview. */
  setDeckMode(mode: DeckMode): void;
  /** Toggle the bird's-eye overview on/off. */
  toggleOverview(): void;
  /** Show the transient Settings overlay over the deck (#482). The deck state is left untouched. Pass a
   *  category id (#731) to land the overlay on that tab; omit it to open on the last-used / default tab
   *  (which clears any previously forced category). */
  showSettings(category?: string): void;
  /** Hide the Settings overlay, returning to the deck as it was. */
  closeSettings(): void;
}

export function createUiChromeSlice(
  set: StoreApi<UiChromeSlice>['setState'],
  get: StoreApi<UiChromeSlice>['getState'],
): UiChromeSlice {
  return {
    center: DEFAULT_CENTER,
    tech: 'editor',
    output: DEFAULT_OUTPUT,
    docs: 'glossary',
    bottom: 'problems',
    right: 'props',
    rightCollapsed: false,
    leftCollapsed: false,
    outlineFilter: '',
    explorerFilter: '',
    explorerCollapsed: [],
    mobileZone: DEFAULT_MOBILE_ZONE,
    railAxis: DEFAULT_RAIL_AXIS,
    diagCollapsed: false,
    diagCollapsedPref: null,
    contextMapView: DEFAULT_CONTEXT_MAP_VIEW,
    panelSide: DEFAULT_PANEL_SIDE,
    sideRail: DEFAULT_SIDE_RAIL,
    theme: 'dark',
    deck: DEFAULT_DECK_STATE,
    settingsOpen: false,
    settingsCategory: null,
    settingsEditorMode: DEFAULT_SETTINGS_EDITOR_MODE,
    settingsJsonScope: DEFAULT_SETTINGS_JSON_SCOPE,

    // `setCenter` = "go to this surface, full" — the legacy single-view semantics map to a 1-up focus.
    setCenter: (v) => get().focusPrimary(v),
    // Facet setters change the surface's sub-view. If that surface isn't currently shown they bring it
    // up 1-up (preserving the old "switch to Code/Output/Docs" behaviour); if it IS shown (primary or
    // secondary) only the facet changes — switching Editor↔Scenarios must not collapse a 2-up, and a
    // facet click on the non-selected pane must not steal the selection (matches the Deck POC).
    setTech: (v) => {
      const { deck } = get();
      if (deck.primary === 'technical' || deck.secondary === 'technical') set({ tech: v });
      else {
        set({ tech: v });
        get().focusPrimary('technical');
      }
    },
    setOutput: (v) => {
      const { deck } = get();
      if (deck.primary === 'output' || deck.secondary === 'output') set({ output: v });
      else {
        set({ output: v });
        get().focusPrimary('output');
      }
    },
    setDocs: (v) => {
      const { deck } = get();
      if (deck.primary === 'docs' || deck.secondary === 'docs') set({ docs: v });
      else {
        set({ docs: v });
        get().focusPrimary('docs');
      }
    },

    setBottom: (t) => set({ bottom: t }),
    setRight: (v) => set({ right: v }),
    setRightCollapsed: (v) => set({ rightCollapsed: v }),
    toggleRightCollapsed: () => set({ rightCollapsed: !get().rightCollapsed }),
    setLeftCollapsed: (v) => set({ leftCollapsed: v }),
    toggleLeftCollapsed: () => set({ leftCollapsed: !get().leftCollapsed }),
    setOutlineFilter: (q) => set({ outlineFilter: q }),
    setExplorerFilter: (q) => set({ explorerFilter: q }),
    toggleExplorerCollapsed: (token) => {
      const cur = get().explorerCollapsed;
      set({ explorerCollapsed: cur.includes(token) ? cur.filter((t) => t !== token) : [...cur, token] });
    },
    setExplorerCollapsedMany: (tokens) => set({ explorerCollapsed: [...tokens] }),
    expandExplorerTokens: (tokens) => {
      const drop = new Set(tokens);
      set({ explorerCollapsed: get().explorerCollapsed.filter((t) => !drop.has(t)) });
    },
    setMobileZone: (z) => set({ mobileZone: z }),
    setRailAxis: (v) => set({ railAxis: v }),
    // The explicit chevron choice: runtime AND preference move together, so the persistence subscriber
    // (which watches the preference) writes the key and the #475 default is thereafter suppressed.
    setDiagCollapsed: (v) => set({ diagCollapsed: v, diagCollapsedPref: v }),
    // The #475 viewport default only sets the runtime flag, and never over an explicit preference — so it
    // never persists and never fights the user's saved choice.
    applyDiagCollapsedDefault: (v) => {
      if (get().diagCollapsedPref !== null) return;
      set({ diagCollapsed: v });
    },
    setContextMapView: (v) => set({ contextMapView: v }),
    setPanelSide: (v) => set({ panelSide: v }),
    togglePanelSide: () => set({ panelSide: get().panelSide === 'bottom' ? 'right' : 'bottom' }),
    setSideRail: (v) => set({ sideRail: v }),
    toggleSideRail: () => set({ sideRail: get().sideRail === 'right' ? 'left' : 'right' }),
    setTheme: (v) => set({ theme: v }),
    setSettingsEditorMode: (v) => set({ settingsEditorMode: v }),
    setSettingsJsonScope: (v) => set({ settingsJsonScope: v }),

    // --- Deck actions (ported from the Deck v2 POC interaction model) ---
    setDeck: (deck) => set({ deck, center: deck.primary }),
    focusPrimary: (view) => {
      // Focusing a deck surface is the natural way to LEAVE the Settings overlay, so clear it here — this
      // is what the deck-bar / palette / selectCenter all route through.
      set({ deck: { ...get().deck, mode: 'focus', primary: view, secondary: null, flipped: false }, center: view, settingsOpen: false });
    },
    openBeside: (view) => {
      const { deck } = get();
      if (view === deck.primary) return;
      const secondary = deck.secondary === view ? null : view;
      set({ deck: { ...deck, mode: 'focus', secondary, flipped: false } });
    },
    closeSurface: (view) => {
      const { deck } = get();
      let { primary } = deck;
      let secondary = deck.secondary;
      if (view === secondary) {
        secondary = null;
      } else if (view === primary) {
        if (!secondary) return; // closing the sole surface — no-op
        primary = secondary;
        secondary = null;
      } else {
        return; // not shown — nothing to close
      }
      set({ deck: { ...deck, primary, secondary, flipped: false }, center: primary });
    },
    swapSides: () => {
      const { deck } = get();
      if (!deck.secondary) return;
      set({ deck: { ...deck, flipped: !deck.flipped } });
    },
    selectPane: (view) => {
      const { deck } = get();
      // Only the non-selected pane of a live 2-up can be selected; swap the roles and compensate
      // `flipped` so neither card moves — only the active-pane cue follows.
      if (deck.mode !== 'focus' || !deck.secondary || view === deck.primary || view !== deck.secondary) return;
      set({
        deck: { ...deck, primary: deck.secondary, secondary: deck.primary, flipped: !deck.flipped },
        center: deck.secondary,
      });
    },
    setRatio: (ratio) => set({ deck: { ...get().deck, ratio: clampRatio(ratio) } }),
    setDeckMode: (mode) => set({ deck: { ...get().deck, mode } }),
    toggleOverview: () => {
      const { deck } = get();
      set({ deck: { ...deck, mode: deck.mode === 'overview' ? 'focus' : 'overview' } });
    },

    // --- Settings overlay (#482), orthogonal to the deck ---
    // A category lands the overlay on that tab (#731); a plain open clears any forced category (null) so
    // the pane opens on its last-used / default tab rather than re-forcing the previous deep-link.
    showSettings: (category) => set({ settingsOpen: true, settingsCategory: category ?? null }),
    closeSettings: () => set({ settingsOpen: false }),
  };
}
