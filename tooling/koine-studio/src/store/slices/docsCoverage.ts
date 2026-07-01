import type { StoreApi } from 'zustand/vanilla';

// Glossary documentation coverage (chrome v2, #923): the model-derived {documented, total} the status-bar
// docs ring renders. Published by the inspector controller whenever it refreshes the context list (folder
// open + every debounced edit — it already fetches the glossary model there), from the shared coverage()
// helper (src/model/glossary.ts). One reactive value so the ring can't drift from the glossary.
export interface DocsCoverageSlice {
  /** Documented vs total glossary entries. `{0,0}` = no model / empty glossary (the ring reads empty). */
  docsCoverage: { documented: number; total: number };
  setDocsCoverage(coverage: { documented: number; total: number }): void;
}

export function createDocsCoverageSlice(
  set: StoreApi<DocsCoverageSlice>['setState'],
): DocsCoverageSlice {
  return {
    docsCoverage: { documented: 0, total: 0 },
    setDocsCoverage: (coverage) => set({ docsCoverage: coverage }),
  };
}
