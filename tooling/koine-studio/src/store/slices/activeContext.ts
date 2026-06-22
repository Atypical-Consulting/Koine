import type { StoreApi } from 'zustand/vanilla';
import { ALL_CONTEXTS, type ContextScope } from '../../activeContext';

export interface ActiveContextSlice {
  /** The active bounded-context scope (a context name, or ALL_CONTEXTS). */
  activeContext: ContextScope;
  /** Set the scope; a no-op when unchanged (so subscribers don't churn). */
  setActiveContext(scope: ContextScope): void;
}

export function createActiveContextSlice(
  set: StoreApi<ActiveContextSlice>['setState'],
  get: StoreApi<ActiveContextSlice>['getState'],
): ActiveContextSlice {
  return {
    activeContext: ALL_CONTEXTS,
    setActiveContext: (scope) => {
      if (scope === get().activeContext) return; // same value in = no churn
      set({ activeContext: scope });
    },
  };
}
