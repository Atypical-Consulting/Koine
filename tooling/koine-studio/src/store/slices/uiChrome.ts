import type { StoreApi } from 'zustand/vanilla';

export type CenterView = 'visual' | 'technical' | 'docs' | 'assistant';
export type TechView = 'editor' | 'preview' | 'check' | 'scenarios';
export type DocsView = 'glossary' | 'adr' | 'notes';
export type BottomTab = 'problems' | 'events' | 'relationships' | 'contextmap' | 'terminal' | 'review';
export type RightView = 'props' | 'rules' | 'notes' | 'source-control';

/** The four zones the narrow-viewport (mobile) shell shows one at a time, switched by the bottom
 *  MobileZoneBar. Code → #center + selectCenter('technical'); Diagram → #center + selectCenter('visual');
 *  Files → #leftrail; Props → #right. Desktop ignores this (the five-track grid shows all panes). */
export type MobileZone = 'files' | 'code' | 'diagram' | 'props';

/** The center pane shown on first run and whenever a persisted/restored value is absent or invalid. */
export const DEFAULT_CENTER: CenterView = 'visual';

/** The zone the mobile shell opens on — Code, so a phone lands on the editor (the primary review surface). */
export const DEFAULT_MOBILE_ZONE: MobileZone = 'code';

/** True when `v` names a real center pane — validates a restored value before trusting it. */
export function isValidCenter(v: string): v is CenterView {
  return v === 'visual' || v === 'technical' || v === 'docs' || v === 'assistant';
}

/** True when `v` names a real mobile zone — validates a restored/external value before trusting it. */
export function isValidMobileZone(v: string): v is MobileZone {
  return v === 'files' || v === 'code' || v === 'diagram' || v === 'props';
}

// --- Center layout (split-pane model) ---

/** A single panel in the center split layout, identified by a stable id. */
export interface CenterPane {
  id: string;
  view: CenterView;
}

/** The full split-pane descriptor for the center area.
 *  `sizes` is a parallel fractional array (one entry per pane, values sum to 1).
 *  `focusedPaneId` is the pane that receives keyboard focus and drives the legacy `center` field. */
export interface CenterLayout {
  orientation: 'row' | 'column';
  panes: CenterPane[];
  sizes: number[];
  focusedPaneId: string;
}

/** Module-level counter so generated pane IDs are deterministic in tests. */
let _paneCounter = 0;
function newPaneId(): string {
  return `pane-${++_paneCounter}`;
}

/** The single-pane default — equivalent to the pre-split `center: 'visual'` state. */
export const DEFAULT_CENTER_LAYOUT: CenterLayout = {
  orientation: 'row',
  panes: [{ id: 'pane-0', view: 'visual' }],
  sizes: [1],
  focusedPaneId: 'pane-0',
};

/** True when `v` is a well-formed {@link CenterLayout} — validates a persisted/restored value. */
export function isValidCenterLayout(v: unknown): v is CenterLayout {
  if (!v || typeof v !== 'object') return false;
  const l = v as CenterLayout;
  if (l.orientation !== 'row' && l.orientation !== 'column') return false;
  if (!Array.isArray(l.panes) || l.panes.length === 0) return false;
  if (!Array.isArray(l.sizes) || l.sizes.length !== l.panes.length) return false;
  if (typeof l.focusedPaneId !== 'string') return false;
  if (!l.panes.some((p) => p.id === l.focusedPaneId)) return false;
  return l.panes.every((p) => typeof p.id === 'string' && isValidCenter(p.view));
}

export interface UiChromeSlice {
  center: CenterView;
  tech: TechView;
  docs: DocsView;
  bottom: BottomTab;
  right: RightView;
  /** Whether the desktop right Properties rail is collapsed. Runtime source of truth, mirrored to
   *  `layoutStore` for persistence (#193: the slice owns chrome state, not the DOM). Independent of
   *  `right` — collapsing remembers the last active view, so re-expanding restores it. */
  rightCollapsed: boolean;
  /** The active mobile zone (single source of truth for the narrow-viewport shell). ide.tsx mirrors it
   *  to #split[data-mobile-zone] so the @media rules show/hide zones; the MobileZoneBar reads + writes it. */
  mobileZone: MobileZone;
  /** The Explorer outline's type-to-filter query. Lives in the store (not panel-local state) because the
   *  controller unmounts + remounts the outline panel on every model reload, which would otherwise wipe a
   *  component-local query mid-task; here it survives the remount. */
  outlineFilter: string;
  /** The multi-pane center layout descriptor. The legacy `center` field mirrors the focused pane's view. */
  centerLayout: CenterLayout;
  setCenter(v: CenterView): void;
  setTech(v: TechView): void;
  setDocs(v: DocsView): void;
  setBottom(t: BottomTab): void;
  setRight(v: RightView): void;
  setRightCollapsed(v: boolean): void;
  toggleRightCollapsed(): void;
  setOutlineFilter(q: string): void;
  setMobileZone(z: MobileZone): void;
  /** Replace the entire center layout; also keeps the legacy `center` field in sync. */
  setCenterLayout(layout: CenterLayout): void;
  /** Add a second pane (clone of the focused pane) with the given orientation. */
  splitCenter(orientation: 'row' | 'column'): void;
  /** Change the view shown in a specific pane. */
  setPaneView(paneId: string, view: CenterView): void;
  /** Update fractional sizes; normalises the array length to match the current pane count. */
  resizeCenter(sizes: number[]): void;
  /** Remove a pane. No-op when only one pane remains. */
  closePane(paneId: string): void;
  /** Set keyboard focus to a pane (and sync the legacy `center` field). */
  focusPane(paneId: string): void;
}

export function createUiChromeSlice(
  set: StoreApi<UiChromeSlice>['setState'],
  get: StoreApi<UiChromeSlice>['getState'],
): UiChromeSlice {
  return {
    center: DEFAULT_CENTER,
    tech: 'editor',
    docs: 'glossary',
    bottom: 'problems',
    right: 'props',
    rightCollapsed: false,
    outlineFilter: '',
    mobileZone: DEFAULT_MOBILE_ZONE,
    centerLayout: DEFAULT_CENTER_LAYOUT,

    // Legacy shims — keep `center` and the focused pane's view in sync
    setCenter: (v) => {
      const { centerLayout } = get();
      const panes = centerLayout.panes.map((p) =>
        p.id === centerLayout.focusedPaneId ? { ...p, view: v } : p,
      );
      set({ center: v, centerLayout: { ...centerLayout, panes } });
    },
    setTech: (v) => {
      const { centerLayout } = get();
      const panes = centerLayout.panes.map((p) =>
        p.id === centerLayout.focusedPaneId ? { ...p, view: 'technical' as CenterView } : p,
      );
      set({ tech: v, center: 'technical', centerLayout: { ...centerLayout, panes } });
    },
    setDocs: (v) => {
      const { centerLayout } = get();
      const panes = centerLayout.panes.map((p) =>
        p.id === centerLayout.focusedPaneId ? { ...p, view: 'docs' as CenterView } : p,
      );
      set({ docs: v, center: 'docs', centerLayout: { ...centerLayout, panes } });
    },

    setBottom: (t) => set({ bottom: t }),
    setRight: (v) => set({ right: v }),
    setRightCollapsed: (v) => set({ rightCollapsed: v }),
    toggleRightCollapsed: () => set({ rightCollapsed: !get().rightCollapsed }),
    setOutlineFilter: (q) => set({ outlineFilter: q }),
    setMobileZone: (z) => set({ mobileZone: z }),

    // Center-layout actions
    setCenterLayout: (layout) => {
      const focused = layout.panes.find((p) => p.id === layout.focusedPaneId) ?? layout.panes[0];
      set({ centerLayout: layout, center: focused.view });
    },
    splitCenter: (orientation) => {
      const { centerLayout } = get();
      // Pick the first view not already used by any pane so each pane gets its
      // own DOM element (there is only one #center-visual / #center-technical /
      // etc. in the document — two panes claiming the same one leaves pane A blank).
      const CYCLE_VIEWS: CenterView[] = ['technical', 'docs', 'assistant', 'visual'];
      const newView = CYCLE_VIEWS.find((v) => !centerLayout.panes.some((p) => p.view === v)) ?? 'technical';
      const newId = newPaneId();
      const panes = [...centerLayout.panes, { id: newId, view: newView }];
      const sizes = panes.map(() => 1 / panes.length);
      set({ centerLayout: { orientation, panes, sizes, focusedPaneId: centerLayout.focusedPaneId } });
    },
    setPaneView: (paneId, view) => {
      const { centerLayout } = get();
      const panes = centerLayout.panes.map((p) => (p.id === paneId ? { ...p, view } : p));
      const focused = panes.find((p) => p.id === centerLayout.focusedPaneId) ?? panes[0];
      set({ centerLayout: { ...centerLayout, panes }, center: focused.view });
    },
    resizeCenter: (sizes) => {
      const { centerLayout } = get();
      let s = sizes.slice(0, centerLayout.panes.length);
      while (s.length < centerLayout.panes.length) s.push(1 / centerLayout.panes.length);
      const total = s.reduce((a, b) => a + b, 0) || 1;
      set({ centerLayout: { ...centerLayout, sizes: s.map((v) => v / total) } });
    },
    closePane: (paneId) => {
      const { centerLayout } = get();
      if (centerLayout.panes.length <= 1) return;
      const panes = centerLayout.panes.filter((p) => p.id !== paneId);
      const sizes = panes.map(() => 1 / panes.length);
      const focusedPaneId = panes.some((p) => p.id === centerLayout.focusedPaneId)
        ? centerLayout.focusedPaneId
        : panes[0].id;
      const focused = panes.find((p) => p.id === focusedPaneId) ?? panes[0];
      set({ centerLayout: { ...centerLayout, panes, sizes, focusedPaneId }, center: focused.view });
    },
    focusPane: (paneId) => {
      const { centerLayout } = get();
      const pane = centerLayout.panes.find((p) => p.id === paneId);
      if (!pane) return;
      set({ centerLayout: { ...centerLayout, focusedPaneId: paneId }, center: pane.view });
    },
  };
}
