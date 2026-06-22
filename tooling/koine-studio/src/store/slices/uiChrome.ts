import type { StoreApi } from 'zustand/vanilla';
import { DEFAULT_MODE_ID, isValidModeId } from '../../modes';

export type CenterView = 'visual' | 'technical' | 'docs';
export type TechView = 'editor' | 'preview' | 'check' | 'assistant';
export type DocsView = 'glossary' | 'adr';
export type BottomTab = 'problems' | 'events' | 'relationships' | 'contextmap';
export type RightView = 'props' | 'rules' | 'notes';

// Maps a workspace mode id (modes.ts: 'domain' | 'code' | 'docs') to the center pane it lands on.
// 'code' → the technical (emitted-code) pane, 'docs' → the docs pane, everything else (incl. the
// default 'domain') → the visual editor. Folding this into one transition is what removes the
// "mode button says X but the center shows Y" divergence.
const centerForMode = (mode: string): CenterView =>
  mode === 'code' ? 'technical' : mode === 'docs' ? 'docs' : 'visual';

export interface UiChromeSlice {
  mode: string;
  center: CenterView;
  tech: TechView;
  docs: DocsView;
  bottom: BottomTab;
  right: RightView;
  setMode(id: string): void;
  setCenter(v: CenterView): void;
  setTech(v: TechView): void;
  setDocs(v: DocsView): void;
  setBottom(t: BottomTab): void;
  setRight(v: RightView): void;
}

export function createUiChromeSlice(
  set: StoreApi<UiChromeSlice>['setState'],
  _get: StoreApi<UiChromeSlice>['getState'],
): UiChromeSlice {
  return {
    mode: DEFAULT_MODE_ID,
    center: centerForMode(DEFAULT_MODE_ID),
    tech: 'editor',
    docs: 'glossary',
    bottom: 'problems',
    right: 'props',
    setMode: (id) => {
      const mode = isValidModeId(id) ? id : DEFAULT_MODE_ID;
      set({ mode, center: centerForMode(mode) });
    },
    setCenter: (v) => set({ center: v }),
    setTech: (v) => set({ tech: v, center: 'technical' }),
    setDocs: (v) => set({ docs: v, center: 'docs' }),
    setBottom: (t) => set({ bottom: t }),
    setRight: (v) => set({ right: v }),
  };
}
