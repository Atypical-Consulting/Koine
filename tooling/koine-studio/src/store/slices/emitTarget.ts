import type { StoreApi } from 'zustand/vanilla';

// The effective emit/preview target (chrome v2, #923): a mirror of the `previewTarget` setting kept in
// the store so the top-bar emit selector AND the status-bar "Emit" echo read ONE reactive value. The
// host (ide.ts) writes it whenever the effective settings are (re)applied — at boot, on a folder open, a
// root-set change, and the Settings Output picker's onChange — so both surfaces stay in lockstep with
// the persisted setting no matter which control changed it. The value is a target id (see EMIT_TARGETS),
// e.g. `csharp` / `typescript`; the display label is looked up at point-of-use.
export interface EmitTargetSlice {
  /** The effective emit target id (mirror of `previewTarget`). Defaults to the settings default. */
  emitTarget: string;
  /** Mirror a new effective emit target into the store. Does NOT persist — the host owns persistence. */
  setEmitTarget(target: string): void;
}

export function createEmitTargetSlice(
  set: StoreApi<EmitTargetSlice>['setState'],
): EmitTargetSlice {
  return {
    // Matches DEFAULT_SETTINGS.previewTarget so the first paint (before the host seeds it) is correct.
    emitTarget: 'csharp',
    setEmitTarget: (target) => set({ emitTarget: target }),
  };
}
