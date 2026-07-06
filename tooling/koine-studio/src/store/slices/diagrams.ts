import type { StoreApi } from 'zustand/vanilla';
import { clampZoomPercent } from '@/diagrams/diagramContract';

// The diagram canvas view-state the IDE flips into the active renderer (chrome refactor, #983): the
// drag-to-edit toggle, the mobile touch presentation, the default zoom band, and the per-workspace
// persist scope. These were four module-level `let`s in `diagramContract.ts`; they now live here as one
// reactive slice, and the diagramContract accessor functions became thin facades delegating to this
// store, so every renderer / canvasWrite / ide call site stays byte-identical. Pure diagram VIEW
// concerns — no DOM, no renderer, no layout engine. The zoom clamp is owned by diagramContract
// (persistence.ts also imports it); the setter here reuses it so a hand-edited value can't break layout.
export interface DiagramsSlice {
  /** Whether diagram nodes accept drag-to-edit gestures (off by default; the read-only tab is byte-identical). */
  diagramEditing: boolean;
  /** Whether the canvas is in mobile TOUCH mode (tap-to-edit; independent of {@link diagramEditing}). */
  diagramTouchMode: boolean;
  /** The default zoom (percent) a freshly-opened canvas uses when no per-diagram zoom is saved (#762). */
  defaultCanvasZoom: number;
  /** The per-workspace scope for persisted node positions (folder identity, or 'scratch'). */
  diagramPersistScope: string;
  /** Enable/disable drag-to-edit gestures on diagram nodes. */
  setDiagramEditing(enabled: boolean): void;
  /** Enable/disable touch (tap-to-edit) presentation on the diagram canvas. */
  setDiagramTouchMode(on: boolean): void;
  /** Set the default canvas zoom (percent), clamped to the diagram zoom band; a non-finite value is ignored. */
  setDefaultCanvasZoom(percent: number): void;
  /** Set the workspace scope for persisted node positions (folder identity, or 'scratch'). */
  setDiagramPersistScope(scope: string): void;
}

export function createDiagramsSlice(
  set: StoreApi<DiagramsSlice>['setState'],
): DiagramsSlice {
  return {
    diagramEditing: false,
    diagramTouchMode: false,
    defaultCanvasZoom: 100,
    diagramPersistScope: 'scratch',
    setDiagramEditing: (enabled) => set({ diagramEditing: enabled }),
    setDiagramTouchMode: (on) => set({ diagramTouchMode: on }),
    setDefaultCanvasZoom: (percent) => {
      const z = clampZoomPercent(percent);
      if (z != null) set({ defaultCanvasZoom: z });
    },
    setDiagramPersistScope: (scope) => set({ diagramPersistScope: scope || 'scratch' }),
  };
}
