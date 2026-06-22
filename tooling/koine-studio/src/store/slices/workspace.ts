import type { StoreApi } from 'zustand/vanilla';
import type { Buffer } from '@/workspaceController';

export interface WorkspaceSlice {
  /** Every open buffer keyed by file:// uri (a read-projection of workspaceController's Map). */
  buffers: Record<string, Buffer>;
  activeUri: string;
  folderRootToken: string;
  setBuffers(b: Record<string, Buffer>): void;
  setActiveUri(uri: string): void;
  setFolderRootToken(token: string): void;
  dirtyCount(): number;
  anyDirty(): boolean;
}

export function createWorkspaceSlice(
  set: StoreApi<WorkspaceSlice>['setState'],
  get: StoreApi<WorkspaceSlice>['getState'],
): WorkspaceSlice {
  return {
    buffers: {},
    activeUri: '',
    folderRootToken: '',
    setBuffers: (b) => set({ buffers: b }),
    setActiveUri: (uri) => set({ activeUri: uri }),
    setFolderRootToken: (token) => set({ folderRootToken: token }),
    dirtyCount: () => Object.values(get().buffers).filter((b) => b.dirty).length,
    anyDirty: () => Object.values(get().buffers).some((b) => b.dirty),
  };
}
