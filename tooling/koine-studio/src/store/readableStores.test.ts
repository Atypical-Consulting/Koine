import { describe, expect, test } from 'vitest';
import { createAppStore } from '@/store/index';
import {
  createDiagnosticsStripStore,
  createDocsPanelHostStore,
  createHistoryControlsStore,
  createUnsavedIndicatorStore,
  createWorkspaceProblemsStore,
} from '@/store/readableStores';
import type { Buffer } from '@/shell/workspaceController';
import type { LspDiagnostic } from '@/lsp/lsp';
import { ALL_CONTEXTS } from '@/model/activeContext';

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

describe('createDiagnosticsStripStore', () => {
  // One error diagnostic on (0-based) line 2, column 3; the panel renders it 1-based as "error 3:4".
  const err = (msg: string): LspDiagnostic => ({
    range: { start: { line: 2, character: 3 }, end: { line: 2, character: 4 } },
    message: msg,
    severity: 1,
  });
  const warn = (msg: string): LspDiagnostic => ({
    range: { start: { line: 5, character: 0 }, end: { line: 5, character: 6 } },
    message: msg,
    severity: 2,
  });
  const uriLabel = (uri: string): string => uri.split('/').pop()!;

  test('unscoped (no scope option): the ACTIVE file’s rows, unlabelled, with the strip’s count wording', () => {
    const store = createAppStore();
    const readable = createDiagnosticsStripStore(store, { activeUri: () => 'file:///a.koi' });
    expect(readable.getState()).toEqual({ scoped: false, rows: [], count: 'clean', kind: 'clean' });

    const boom = err('boom');
    store.getState().setDiagnostics('file:///a.koi', [boom, warn('meh')]);
    store.getState().setDiagnostics('file:///b.koi', [err('elsewhere')]); // a different file — not shown

    const slice = readable.getState();
    expect(slice.scoped).toBe(false);
    // The shared diagnosticsSummary wording, joined with the strip's ' · ' (byte-for-byte renderStrip).
    expect(slice.count).toBe('1 error · 1 warning');
    expect(slice.kind).toBe('error');
    expect(slice.rows).toEqual([
      { uri: 'file:///a.koi', severity: 'error', range: boom.range, message: 'boom', code: undefined },
      expect.objectContaining({ severity: 'warning', message: 'meh' }),
    ]);
    expect(slice.rows[0].label).toBeUndefined();
  });

  test('a real active context (with scope) follows THAT context’s files — not the active file (ADR 0009)', () => {
    const store = createAppStore();
    // The OPEN file is Ordering, but the scope is Billing — the strip must follow the CONTEXT.
    store.getState().setActiveContext('Billing');
    const readable = createDiagnosticsStripStore(store, {
      activeUri: () => 'file:///Ordering.koi',
      scope: { uriLabel },
    });
    store.getState().setDiagnostics('file:///Billing.koi', [err('billing boom')]);
    store.getState().setDiagnostics('file:///Ordering.koi', [err('ordering boom')]);

    const slice = readable.getState();
    expect(slice.scoped).toBe(true);
    expect(slice.count).toBe('1 error');
    // Only Billing's — Ordering is a different context, and it's the OPEN file. Scoped rows are labelled.
    expect(slice.rows.length).toBe(1);
    expect(slice.rows[0]).toEqual(
      expect.objectContaining({ uri: 'file:///Billing.koi', label: 'Billing.koi', message: 'billing boom' }),
    );
  });

  test('All contexts (with scope provided) still yields the ACTIVE file’s slice, byte-for-byte', () => {
    const store = createAppStore(); // activeContext defaults to ALL_CONTEXTS
    expect(store.getState().activeContext).toBe(ALL_CONTEXTS);
    const readable = createDiagnosticsStripStore(store, {
      activeUri: () => 'file:///Ordering.koi',
      scope: { uriLabel },
    });
    store.getState().setDiagnostics('file:///Billing.koi', [err('billing')]);
    store.getState().setDiagnostics('file:///Ordering.koi', [err('ordering')]);

    const slice = readable.getState();
    expect(slice.scoped).toBe(false);
    expect(slice.rows.length).toBe(1);
    expect(slice.rows[0].message).toBe('ordering'); // the active file
    expect(slice.rows[0].label).toBeUndefined(); // unscoped rows are NOT file-labelled
  });

  test('the selector reads activeUri LIVE — getState() after a file switch reflects the new file', () => {
    const store = createAppStore();
    let active = 'file:///a.koi';
    const readable = createDiagnosticsStripStore(store, { activeUri: () => active });
    store.getState().setDiagnostics('file:///a.koi', [err('a boom')]);
    store.getState().setDiagnostics('file:///b.koi', [warn('b meh')]);
    expect(readable.getState().rows[0].message).toBe('a boom');

    // The active-file switch happens OUTSIDE the store; the next read must still see it (this is what
    // lets editorSession's paintActive repaint the mounted panel synchronously on a file switch).
    active = 'file:///b.koi';
    expect(readable.getState().rows[0].message).toBe('b meh');
    expect(readable.getState().count).toBe('1 warning');
  });

  test('does NOT notify on an unrelated write once diagnostics exist (rows are rebuilt fresh per read)', () => {
    const store = createAppStore();
    store.getState().setDiagnostics('file:///a.koi', [err('boom')]);
    const readable = createDiagnosticsStripStore(store, { activeUri: () => 'file:///a.koi' });
    let calls = 0;
    readable.subscribe(() => calls++);

    store.getState().setNavAltitude('tactical'); // unrelated slice; diagnostics unchanged
    expect(calls).toBe(0);

    // A real diagnostics change for the selected file DOES notify.
    store.getState().setDiagnostics('file:///a.koi', [err('boom'), warn('meh')]);
    expect(calls).toBe(1);

    // A push for a DIFFERENT file leaves the unscoped active-file slice untouched — no notification.
    store.getState().setDiagnostics('file:///b.koi', [err('elsewhere')]);
    expect(calls).toBe(1);
  });
});

describe('createDocsPanelHostStore', () => {
  test('getState() forwards the workspace slice’s folderRootToken', () => {
    const store = createAppStore();
    const readable = createDocsPanelHostStore(store);
    expect(readable.getState()).toEqual({ folderRootToken: '' });

    store.getState().setRoots(['WS-A', 'WS-B']);
    expect(readable.getState()).toEqual({ folderRootToken: 'WS-A' }); // the PRIMARY root
  });

  test('notifies on a folder change and not on an unrelated store write', () => {
    const store = createAppStore();
    store.getState().setRoots(['WS-A']);
    const readable = createDocsPanelHostStore(store);
    let seen: unknown;
    let calls = 0;
    readable.subscribe((s) => {
      seen = s;
      calls++;
    });

    store.getState().setNavAltitude('tactical'); // unrelated slice
    expect(calls).toBe(0);

    store.getState().setRoots(['WS-B']);
    expect(calls).toBe(1);
    expect(seen).toEqual({ folderRootToken: 'WS-B' });

    // Re-setting the SAME primary root leaves the token unchanged — no notification, so the
    // folder-derived docs pages never reload on a no-op roots write.
    store.getState().setRoots(['WS-B', 'WS-C']);
    expect(calls).toBe(1);
  });
});
