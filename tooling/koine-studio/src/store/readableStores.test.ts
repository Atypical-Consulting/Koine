import { describe, expect, test } from 'vitest';
import { createAppStore } from '@/store/index';
import {
  createHistoryControlsStore,
  createUnsavedIndicatorStore,
  createWorkspaceProblemsStore,
} from '@/store/readableStores';
import type { Buffer } from '@/shell/workspaceController';

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

describe('createUnsavedIndicatorStore', () => {
  // Build the real Buffer (uri, path, relPath, name, text, dirty, rootToken) and seed the whole
  // store-owned buffer Map (#982): the slice keys buffers by uri, so build the Map from each buffer's
  // own uri and set it wholesale.
  const buf = (uri: string, dirty: boolean): Buffer => ({
    uri,
    path: uri,
    relPath: uri,
    name: uri,
    text: '',
    dirty,
    rootToken: '',
  });
  const seed = (...bufs: Buffer[]): Map<string, Buffer> => new Map(bufs.map((b) => [b.uri, b]));

  test('getState() counts the dirty buffers from the workspace slice', () => {
    const store = createAppStore();
    const readable = createUnsavedIndicatorStore(store);
    expect(readable.getState()).toEqual({ dirtyCount: 0 });

    store.setState({ buffers: seed(buf('a', true), buf('b', true), buf('c', false)) });
    expect(readable.getState()).toEqual({ dirtyCount: 2 });
  });

  test('notifies on a dirty-count change and not on a write that leaves the count unchanged', () => {
    const store = createAppStore();
    const readable = createUnsavedIndicatorStore(store);
    let seen: unknown;
    let calls = 0;
    readable.subscribe((s) => {
      seen = s;
      calls++;
    });

    store.getState().setNavAltitude('tactical'); // unrelated slice
    expect(calls).toBe(0);

    store.setState({ buffers: seed(buf('a', true)) });
    expect(calls).toBe(1);
    expect(seen).toEqual({ dirtyCount: 1 });

    // A buffer-set churn that keeps the dirty total identical (the common no-op repaint the ORIGINAL
    // component gated with its own `last` check) must not notify — the adapter owns that gate now.
    store.setState({ buffers: seed(buf('b', true), buf('c', false)) });
    expect(calls).toBe(1);
  });
});

describe('createWorkspaceProblemsStore', () => {
  test('getState() forwards diagnosticsSummary’s kind/parts across all files unchanged', () => {
    const store = createAppStore();
    const readable = createWorkspaceProblemsStore(store);
    expect(readable.getState()).toEqual({ kind: 'clean', parts: [], fileCount: 0 });

    store.getState().setDiagnostics('file:///a.koi', [
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message: 'boom', severity: 1 },
    ]);
    store.getState().setDiagnostics('file:///b.koi', [
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message: 'careful', severity: 2 },
    ]);

    expect(readable.getState()).toEqual({ kind: 'error', parts: ['1 error', '1 warning'], fileCount: 2 });
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

  // Pins the fix for a real bug: `parts` is a freshly built array on every selector call, so a naive
  // shallow/Object.is equality check would treat two content-identical arrays as different and notify on
  // every unrelated write once any diagnostic exists. `createWorkspaceProblemsStore` uses a dedicated
  // element-wise equality (`problemsSliceEqual`) specifically to avoid that regression.
  test('does NOT notify on an unrelated write once diagnostics exist (parts array content-equality)', () => {
    const store = createAppStore();
    store.getState().setDiagnostics('file:///a.koi', [
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message: 'boom', severity: 1 },
    ]);
    const readable = createWorkspaceProblemsStore(store);
    let calls = 0;
    readable.subscribe(() => calls++);

    store.getState().setNavAltitude('tactical'); // unrelated slice; diagnostics unchanged

    expect(calls).toBe(0);
  });
});
