import { describe, expect, test } from 'vitest';
import { createAppStore } from '@/store/index';
import { createHistoryControlsStore, createWorkspaceProblemsStore } from '@/store/readableStores';

// Pins the REAL wiring end-to-end (a real createAppStore(), not a mock ReadableStore) so a change to the
// app store's shape or to diagnosticsSummary's classification is caught here — the koine-ui side
// (HistoryControls.test.tsx / WorkspaceProblemsBadge.test.tsx) exercises the components against a mock
// ReadableStore, and readableStoreAdapter.test.ts exercises zustandToReadableStore generically; this file
// is the seam between them.

describe('createHistoryControlsStore', () => {
  test('getState() reflects the store’s history slice', () => {
    const store = createAppStore();
    const readable = createHistoryControlsStore(store);
    expect(readable.getState()).toEqual({ canUndo: false, canRedo: false });

    store.getState().setHistoryState({ canUndo: true, canRedo: false });
    expect(readable.getState()).toEqual({ canUndo: true, canRedo: false });
  });

  test('notifies on a real canUndo/canRedo change and not on an unrelated store write', () => {
    const store = createAppStore();
    const readable = createHistoryControlsStore(store);
    let seen: unknown;
    let calls = 0;
    readable.subscribe((s) => {
      seen = s;
      calls++;
    });

    store.getState().setNavAltitude('tactical'); // unrelated slice
    expect(calls).toBe(0);

    store.getState().setHistoryState({ canUndo: true, canRedo: true });
    expect(calls).toBe(1);
    expect(seen).toEqual({ canUndo: true, canRedo: true });
  });
});

describe('createWorkspaceProblemsStore', () => {
  test('getState() summarises errors/warnings across all files via diagnosticsSummary', () => {
    const store = createAppStore();
    const readable = createWorkspaceProblemsStore(store);
    expect(readable.getState()).toEqual({ errors: 0, warnings: 0, fileCount: 0 });

    store.getState().setDiagnostics('file:///a.koi', [
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message: 'boom', severity: 1 },
    ]);
    store.getState().setDiagnostics('file:///b.koi', [
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message: 'careful', severity: 2 },
    ]);

    expect(readable.getState()).toEqual({ errors: 1, warnings: 1, fileCount: 2 });
  });

  test('notifies on a diagnostics push and not on an unrelated store write', () => {
    const store = createAppStore();
    const readable = createWorkspaceProblemsStore(store);
    let calls = 0;
    readable.subscribe(() => calls++);

    store.getState().setNavAltitude('tactical'); // unrelated slice
    expect(calls).toBe(0);

    store.getState().setDiagnostics('file:///a.koi', [
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message: 'boom', severity: 1 },
    ]);
    expect(calls).toBe(1);
  });
});
