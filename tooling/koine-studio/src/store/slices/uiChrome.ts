import type { StoreApi } from 'zustand/vanilla';

export type CenterView = 'visual' | 'technical' | 'docs' | 'assistant';
export type TechView = 'editor' | 'preview' | 'check' | 'scenarios';
export type DocsView = 'glossary' | 'adr' | 'notes';
export type BottomTab = 'problems' | 'events' | 'relationships' | 'contextmap' | 'terminal';
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

export interface UiChromeSlice {
  center: CenterView;
  tech: TechView;
  docs: DocsView;
  bottom: BottomTab;
  right: RightView;
  /** The active mobile zone (single source of truth for the narrow-viewport shell). ide.tsx mirrors it
   *  to #split[data-mobile-zone] so the @media rules show/hide zones; the MobileZoneBar reads + writes it. */
  mobileZone: MobileZone;
  /** The Explorer outline's type-to-filter query. Lives in the store (not panel-local state) because the
   *  controller unmounts + remounts the outline panel on every model reload, which would otherwise wipe a
   *  component-local query mid-task; here it survives the remount. */
  outlineFilter: string;
  setCenter(v: CenterView): void;
  setTech(v: TechView): void;
  setDocs(v: DocsView): void;
  setBottom(t: BottomTab): void;
  setRight(v: RightView): void;
  setOutlineFilter(q: string): void;
  setMobileZone(z: MobileZone): void;
}

export function createUiChromeSlice(
  set: StoreApi<UiChromeSlice>['setState'],
  _get: StoreApi<UiChromeSlice>['getState'],
): UiChromeSlice {
  return {
    center: DEFAULT_CENTER,
    tech: 'editor',
    docs: 'glossary',
    bottom: 'problems',
    right: 'props',
    outlineFilter: '',
    mobileZone: DEFAULT_MOBILE_ZONE,
    setCenter: (v) => set({ center: v }),
    setTech: (v) => set({ tech: v, center: 'technical' }),
    setDocs: (v) => set({ docs: v, center: 'docs' }),
    setBottom: (t) => set({ bottom: t }),
    setRight: (v) => set({ right: v }),
    setOutlineFilter: (q) => set({ outlineFilter: q }),
    setMobileZone: (z) => set({ mobileZone: z }),
  };
}
