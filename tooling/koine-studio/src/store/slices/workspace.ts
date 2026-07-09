import type { StoreApi } from 'zustand/vanilla';

/**
 * A client-side open buffer keyed by its file:// uri — the file path, text content, dirty flag, and root token.
 *
 * This type LIVES in the store layer (#982): the workspace slice is the single owner of the buffer set,
 * so its element type must be defined here — the workspace controller re-exports it for back-compat, so
 * the store layer no longer imports from the shell layer (the old inversion). The shell imports the
 * slice, never the reverse.
 */
export interface Buffer {
  uri: string;
  path: string;
  relPath: string;
  name: string;
  text: string;
  dirty: boolean;
  /** The workspace root this buffer's file lives under. */
  rootToken: string;
}

export interface WorkspaceSlice {
  /** Every open buffer keyed by its file:// uri — the single canonical representation (#982, was a
   *  Record projection of the controller's Map). Immutable: every action produces a NEW Map.
   *  Readonly<Buffer> (#1010, shallow but sufficient — every field is a primitive): a Buffer read off
   *  this map can never be mutated in place, from ANY consumer (facade or direct store access alike) —
   *  every write must go through one of the actions below. */
  buffers: ReadonlyMap<string, Readonly<Buffer>>;
  /** The uri the editor currently shows / all LSP requests target ('' before any file opens). */
  activeUri: string;
  /** Every workspace root in add order; the first is the primary ({@link folderRootToken}). */
  roots: readonly string[];
  /** The primary root (`roots[0] ?? ''`), set ATOMICALLY with {@link roots} so folder-derived selectors
   *  (DocsPanelHost, statusBar) keep firing on a change without extra wiring. */
  folderRootToken: string;

  // --- transition markers (replace the controller's callback seams) -----------
  // Monotonic seq fields bumped at EXACTLY the points the corresponding controller callback fires today
  // (workspaceController.ts:484/:918/:370/:941,:949,:1023,:1078); ide.tsx subscribes to them. The
  // docViews slice's {loaded, token} bump is the precedent.
  /** Bumped when the active buffer is switched (the old onActiveChanged; NOT on a silent folder open). */
  activationSeq: number;
  /** Bumped after a cross-file WorkspaceEdit was applied (the old onBuffersChanged). */
  workspaceEditSeq: number;
  /** Bumped after the explorer entry tree is re-read (the old onEntriesRefreshed). */
  entriesSeq: number;
  /** Bumped after a save writes buffer(s) to disk (the old onSaved). */
  saveSeq: number;

  // --- pure actions (no side effects — effects stay in the shell modules) -----
  /** Insert or replace a buffer (new Map). */
  upsertBuffer(buf: Buffer): void;
  /** Insert or replace MANY buffers atomically (ONE new Map, ONE set()) — the batched sibling of
   *  {@link upsertBuffer} for callers (like historyController.restore) that update several buffers as
   *  one logical transition. A true no-op (same Map reference, no notification) for an empty array. */
  upsertBuffers(patches: ReadonlyArray<Buffer>): void;
  /** Remove a buffer by uri (new Map); a no-op (same reference) when the uri isn't open. */
  removeBuffer(uri: string): void;
  /** Re-key `oldUri` → `next.uri` atomically; when `oldUri` was active, re-point `activeUri` in the
   *  SAME set so no subscriber observes a half-rekeyed state. */
  rekeyBuffer(oldUri: string, next: Buffer): void;
  /** Write `text` into `uri`'s buffer, flipping it dirty on first change. Returns whether the dirty dot
   *  just appeared; a no-op (same state reference) when the text is unchanged or the uri isn't open. */
  syncBufferText(uri: string, text: string): boolean;
  /** Clear the dirty flag on the given uris post-write (new Map); skips already-clean ones. */
  markSaved(uris: readonly string[]): void;
  /** Move `activeUri` to `uri`. This ONLY moves the pointer — it never fires the activation seam, so
   *  folder-open / delete-fallback (which must not signal activation) call it alone, and a real file
   *  switch calls it (before the doc swap) then {@link bumpActivation} (after it). */
  setActive(uri: string): void;
  /** Fire the activation seam: bump `activationSeq` only (no uri change). Paired with a prior
   *  {@link setActive} so the activeUri moves before the editor doc swap but the seam fires after it. */
  bumpActivation(): void;
  /** Replace `roots` and derive `folderRootToken` (`roots[0] ?? ''`) atomically. */
  setRoots(roots: readonly string[]): void;

  bumpWorkspaceEdit(): void;
  bumpEntries(): void;
  bumpSaved(): void;

  dirtyCount(): number;
  anyDirty(): boolean;
}

export function createWorkspaceSlice(
  set: StoreApi<WorkspaceSlice>['setState'],
  get: StoreApi<WorkspaceSlice>['getState'],
): WorkspaceSlice {
  return {
    buffers: new Map<string, Buffer>(),
    activeUri: '',
    roots: [],
    folderRootToken: '',
    activationSeq: 0,
    workspaceEditSeq: 0,
    entriesSeq: 0,
    saveSeq: 0,

    upsertBuffer: (buf) => {
      const next = new Map(get().buffers);
      next.set(buf.uri, buf);
      set({ buffers: next });
    },
    upsertBuffers: (patches) => {
      if (patches.length === 0) return; // true no-op — no Map copy, no set()
      const next = new Map(get().buffers);
      for (const buf of patches) next.set(buf.uri, buf);
      set({ buffers: next });
    },
    removeBuffer: (uri) => {
      const cur = get().buffers;
      if (!cur.has(uri)) return; // no-op — keep the same reference so subscribers don't churn
      const next = new Map(cur);
      next.delete(uri);
      set({ buffers: next });
    },
    rekeyBuffer: (oldUri, nextBuf) => {
      const cur = get().buffers;
      const next = new Map(cur);
      next.delete(oldUri);
      next.set(nextBuf.uri, nextBuf);
      // Re-point active atomically (one set) so no subscriber observes a half-rekeyed state.
      const patch: Partial<WorkspaceSlice> = { buffers: next };
      if (get().activeUri === oldUri) patch.activeUri = nextBuf.uri;
      set(patch);
    },
    syncBufferText: (uri, text) => {
      const cur = get().buffers;
      const buf = cur.get(uri);
      if (!buf) return false; // unknown uri — nothing to sync
      if (buf.text === text) return false; // unchanged — no state churn (mirrors the old syncBuffer no-op)
      const becameDirty = !buf.dirty; // the dot appears only on the clean → dirty transition
      const next = new Map(cur);
      next.set(uri, { ...buf, text, dirty: true });
      set({ buffers: next });
      return becameDirty;
    },
    markSaved: (uris) => {
      const cur = get().buffers;
      const next = new Map(cur);
      let changed = false;
      for (const uri of uris) {
        const buf = next.get(uri);
        if (buf && buf.dirty) {
          next.set(uri, { ...buf, dirty: false });
          changed = true;
        }
      }
      if (changed) set({ buffers: next });
    },
    setActive: (uri) => set({ activeUri: uri }),
    bumpActivation: () => set({ activationSeq: get().activationSeq + 1 }),
    setRoots: (roots) => {
      const copy = [...roots];
      set({ roots: copy, folderRootToken: copy[0] ?? '' });
    },

    bumpWorkspaceEdit: () => set({ workspaceEditSeq: get().workspaceEditSeq + 1 }),
    bumpEntries: () => set({ entriesSeq: get().entriesSeq + 1 }),
    bumpSaved: () => set({ saveSeq: get().saveSeq + 1 }),

    dirtyCount: () => {
      let n = 0;
      for (const b of get().buffers.values()) if (b.dirty) n++;
      return n;
    },
    anyDirty: () => {
      for (const b of get().buffers.values()) if (b.dirty) return true;
      return false;
    },
  };
}
