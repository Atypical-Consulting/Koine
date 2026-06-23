import type { StoreApi } from 'zustand/vanilla';
import type { LspDiagnostic } from '@/lsp/lsp';

export interface DiagnosticsSlice {
  /** Per-uri diagnostics cache (the workspace-wide latest push for every file). */
  diagnosticsByUri: Record<string, LspDiagnostic[]>;
  diagnosticsFor(uri: string): LspDiagnostic[];
  setDiagnostics(uri: string, diags: LspDiagnostic[]): void;
  dropDiagnostics(uri: string): void;
  renameDiagnostics(oldUri: string, newUri: string): void;
  clearDiagnostics(): void;
}

export function createDiagnosticsSlice(
  set: StoreApi<DiagnosticsSlice>['setState'],
  get: StoreApi<DiagnosticsSlice>['getState'],
): DiagnosticsSlice {
  return {
    diagnosticsByUri: {},
    diagnosticsFor: (uri) => get().diagnosticsByUri[uri] ?? [],
    setDiagnostics: (uri, diags) =>
      set({ diagnosticsByUri: { ...get().diagnosticsByUri, [uri]: diags } }),
    dropDiagnostics: (uri) => {
      const next = { ...get().diagnosticsByUri };
      delete next[uri];
      set({ diagnosticsByUri: next });
    },
    renameDiagnostics: (oldUri, newUri) => {
      const map = get().diagnosticsByUri;
      const diags = map[oldUri];
      const next = { ...map };
      delete next[oldUri];
      if (diags) next[newUri] = diags;
      set({ diagnosticsByUri: next });
    },
    clearDiagnostics: () => set({ diagnosticsByUri: {} }),
  };
}
