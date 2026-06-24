import type { StoreApi } from 'zustand/vanilla';
import { ALL_CONTEXTS, type ContextScope } from '@/model/activeContext';

export interface ActiveContextSlice {
  /** The active bounded-context scope (a context name, or ALL_CONTEXTS). */
  activeContext: ContextScope;
  /** Set the scope; a no-op when unchanged (so subscribers don't churn). */
  setActiveContext(scope: ContextScope): void;
  /** The model's bounded contexts — the scope selector's options after "All contexts" — in model order.
   *  Surfaced in the store (not just the breadcrumb) so the construct palette can react to it: it enables
   *  the add buttons under "All contexts" when there's a single, unambiguous, home context. */
  contexts: string[];
  /** Replace the known bounded-context list; a no-op when unchanged (so subscribers don't churn). */
  setContexts(list: string[]): void;
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
    contexts: [],
    setContexts: (list) => {
      const prev = get().contexts;
      if (prev.length === list.length && prev.every((c, i) => c === list[i])) return; // unchanged = no churn
      set({ contexts: list });
    },
  };
}
