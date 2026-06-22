import { describe, expect, test } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { createWorkspaceSlice, type WorkspaceSlice } from './workspace';
import type { Buffer } from '../../workspaceController';

const buf = (uri: string, dirty: boolean): Buffer =>
  ({ uri, path: uri, relPath: uri, name: uri, text: '', dirty });

const make = () => createStore<WorkspaceSlice>((set, get) => createWorkspaceSlice(set, get));

describe('workspace slice', () => {
  test('dirtyCount / anyDirty reflect the buffer set', () => {
    const s = make().getState();
    expect(s.anyDirty()).toBe(false);
    s.setBuffers({ a: buf('a', true), b: buf('b', false) });
    const next = make();
    next.getState().setBuffers({ a: buf('a', true), b: buf('b', false) });
    expect(next.getState().dirtyCount()).toBe(1);
    expect(next.getState().anyDirty()).toBe(true);
  });

  test('setActiveUri / setFolderRootToken update state', () => {
    const s = make();
    s.getState().setActiveUri('file:///x.koi');
    s.getState().setFolderRootToken('/root');
    expect(s.getState().activeUri).toBe('file:///x.koi');
    expect(s.getState().folderRootToken).toBe('/root');
  });
});
