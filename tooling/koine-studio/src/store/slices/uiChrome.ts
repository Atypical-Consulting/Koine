import type { StoreApi } from 'zustand/vanilla';

export type CenterView = 'visual' | 'technical' | 'docs';
export type TechView = 'editor' | 'preview' | 'check' | 'assistant';
export type DocsView = 'glossary' | 'adr' | 'notes';
export type BottomTab = 'problems' | 'events' | 'relationships' | 'contextmap';
export type RightView = 'props' | 'rules' | 'notes';

/** The center pane shown on first run and whenever a persisted/restored value is absent or invalid. */
export const DEFAULT_CENTER: CenterView = 'visual';

/** True when `v` names a real center pane — validates a restored value before trusting it. */
export function isValidCenter(v: string): v is CenterView {
  return v === 'visual' || v === 'technical' || v === 'docs';
}

export interface UiChromeSlice {
  center: CenterView;
  tech: TechView;
  docs: DocsView;
  bottom: BottomTab;
  right: RightView;
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
    setCenter: (v) => set({ center: v }),
    setTech: (v) => set({ tech: v, center: 'technical' }),
    setDocs: (v) => set({ docs: v, center: 'docs' }),
    setBottom: (t) => set({ bottom: t }),
    setRight: (v) => set({ right: v }),
    setOutlineFilter: (q) => set({ outlineFilter: q }),
  };
}
