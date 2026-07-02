import { describe, expect, test } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { createWorkspaceSlice, type Buffer, type WorkspaceSlice } from '@/store/slices/workspace';

const buf = (uri: string, over: Partial<Buffer> = {}): Buffer => ({
  uri,
  path: uri,
  relPath: uri,
  name: uri,
  text: '',
  dirty: false,
  rootToken: '',
  ...over,
});

const make = () => createStore<WorkspaceSlice>((set, get) => createWorkspaceSlice(set, get));

// The workspace slice is the single owner of buffers/activeUri/roots/dirty (#982). These tests assert
// the pure state transitions in isolation: immutable Map semantics (a new Map per change), atomic
// rekey+activeUri, the becameDirty contract, folderRootToken derived from roots, and the silent/loud
// activation seq. Effects (LSP, disk, diagnostics) live in the shell modules and are not exercised here.
describe('workspace slice — owner API (#982)', () => {
  test('upsertBuffer inserts into a NEW Map (reference inequality)', () => {
    const s = make();
    const before = s.getState().buffers;
    s.getState().upsertBuffer(buf('file://a'));
    const after = s.getState().buffers;
    expect(after).not.toBe(before);
    expect(after.get('file://a')).toBeDefined();
    expect(after.size).toBe(1);
  });

  test('removeBuffer produces a NEW Map without the uri, and no-ops (same reference) when absent', () => {
    const s = make();
    s.getState().upsertBuffer(buf('file://a'));
    const withA = s.getState().buffers;
    s.getState().removeBuffer('file://a');
    const without = s.getState().buffers;
    expect(without).not.toBe(withA);
    expect(without.has('file://a')).toBe(false);
    // An absent uri is a no-op: the same Map reference is retained (no needless subscriber churn).
    const ref = s.getState().buffers;
    s.getState().removeBuffer('file://ghost');
    expect(s.getState().buffers).toBe(ref);
  });

  test('rekeyBuffer re-keys in a NEW Map and re-points activeUri when the old uri was active (one set)', () => {
    const s = make();
    s.getState().upsertBuffer(buf('file://old', { dirty: true, text: 'x' }));
    s.getState().setActive('file://old', { silent: true });
    const before = s.getState().buffers;
    s.getState().rekeyBuffer('file://old', buf('file://new', { dirty: true, text: 'x' }));
    const after = s.getState().buffers;
    expect(after).not.toBe(before);
    expect(after.has('file://old')).toBe(false);
    expect(after.get('file://new')!.dirty).toBe(true);
    expect(after.get('file://new')!.text).toBe('x');
    // activeUri followed the rekey — in the SAME set, so no subscriber sees a half-rekeyed state.
    expect(s.getState().activeUri).toBe('file://new');
  });

  test('rekeyBuffer leaves activeUri alone when the old uri was NOT active', () => {
    const s = make();
    s.getState().upsertBuffer(buf('file://a'));
    s.getState().upsertBuffer(buf('file://b'));
    s.getState().setActive('file://a', { silent: true });
    s.getState().rekeyBuffer('file://b', buf('file://b2'));
    expect(s.getState().activeUri).toBe('file://a');
    expect(s.getState().buffers.has('file://b2')).toBe(true);
  });

  test('syncBufferText returns becameDirty only when a CLEAN buffer’s text changes', () => {
    const s = make();
    s.getState().upsertBuffer(buf('file://a', { text: 'v1', dirty: false }));
    // clean → changed: the dirty dot just appeared, and the new text landed
    expect(s.getState().syncBufferText('file://a', 'v2')).toBe(true);
    expect(s.getState().buffers.get('file://a')!.dirty).toBe(true);
    expect(s.getState().buffers.get('file://a')!.text).toBe('v2');
    // already dirty → changed again: the text updates but becameDirty is false (dot already shown)
    expect(s.getState().syncBufferText('file://a', 'v3')).toBe(false);
    expect(s.getState().buffers.get('file://a')!.text).toBe('v3');
    expect(s.getState().buffers.get('file://a')!.dirty).toBe(true);
  });

  test('syncBufferText no-ops (same state reference) when the text is unchanged or the uri is unknown', () => {
    const s = make();
    s.getState().upsertBuffer(buf('file://a', { text: 'same', dirty: false }));
    const ref = s.getState().buffers;
    expect(s.getState().syncBufferText('file://a', 'same')).toBe(false); // unchanged text
    expect(s.getState().buffers).toBe(ref); // no new Map
    expect(s.getState().syncBufferText('file://ghost', 'x')).toBe(false); // unknown uri
    expect(s.getState().buffers).toBe(ref);
  });

  test('markSaved clears the dirty flag on the named uris (new Map), skipping already-clean ones', () => {
    const s = make();
    s.getState().upsertBuffer(buf('file://a', { dirty: true }));
    s.getState().upsertBuffer(buf('file://b', { dirty: true }));
    const before = s.getState().buffers;
    s.getState().markSaved(['file://a']);
    const after = s.getState().buffers;
    expect(after).not.toBe(before);
    expect(after.get('file://a')!.dirty).toBe(false);
    expect(after.get('file://b')!.dirty).toBe(true);
    // No dirty targets → no churn (same reference).
    const ref = s.getState().buffers;
    s.getState().markSaved(['file://a']); // already clean
    expect(s.getState().buffers).toBe(ref);
  });

  test('setRoots sets folderRootToken to roots[0] ?? "" atomically', () => {
    const s = make();
    s.getState().setRoots(['mem://x', 'mem://y']);
    expect(s.getState().roots).toEqual(['mem://x', 'mem://y']);
    expect(s.getState().folderRootToken).toBe('mem://x');
    s.getState().setRoots([]);
    expect(s.getState().folderRootToken).toBe('');
  });

  test('setActive bumps activationSeq unless {silent:true}', () => {
    const s = make();
    const seq0 = s.getState().activationSeq;
    s.getState().setActive('file://a');
    expect(s.getState().activeUri).toBe('file://a');
    expect(s.getState().activationSeq).toBe(seq0 + 1);
    // silent: activeUri still moves, but the seq is untouched (the folder-open / delete-fallback contract).
    s.getState().setActive('file://b', { silent: true });
    expect(s.getState().activeUri).toBe('file://b');
    expect(s.getState().activationSeq).toBe(seq0 + 1);
  });

  test('the workspaceEdit / entries / saved seq bumps are monotonic and independent', () => {
    const s = make();
    const { workspaceEditSeq: w0, entriesSeq: e0, saveSeq: v0 } = s.getState();
    s.getState().bumpWorkspaceEdit();
    s.getState().bumpEntries();
    s.getState().bumpSaved();
    expect(s.getState().workspaceEditSeq).toBe(w0 + 1);
    expect(s.getState().entriesSeq).toBe(e0 + 1);
    expect(s.getState().saveSeq).toBe(v0 + 1);
  });

  test('dirtyCount / anyDirty reflect the buffer Map', () => {
    const s = make();
    expect(s.getState().anyDirty()).toBe(false);
    expect(s.getState().dirtyCount()).toBe(0);
    s.getState().upsertBuffer(buf('file://a', { dirty: true }));
    s.getState().upsertBuffer(buf('file://b', { dirty: false }));
    s.getState().upsertBuffer(buf('file://c', { dirty: true }));
    expect(s.getState().dirtyCount()).toBe(2);
    expect(s.getState().anyDirty()).toBe(true);
  });
});
