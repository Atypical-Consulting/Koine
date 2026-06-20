// Pure helpers over the open-buffer set, factored out of the IDE shell so unsaved-work tracking
// (Save-all, the global dirty indicator, the unload guard) is unit-testable without a DOM or a live
// editor. No imports, no app state — every function is pure over a minimal structural buffer shape
// (the IDE's full `Buffer` in ide.ts is a structural match).

/** The slice of an open buffer these helpers read to decide if it has unsaved changes. */
export interface DirtyLike {
  dirty: boolean;
}

/** A persistable buffer: a real `path` is written to disk; `null` is an unsaved scratch buffer. */
export interface SaveableBuffer extends DirtyLike {
  path: string | null;
}

/** Every buffer with unsaved changes, in the map's iteration order. */
export function dirtyBuffers<T extends DirtyLike>(buffers: Map<string, T>): T[] {
  return Array.from(buffers.values()).filter((b) => b.dirty);
}

/** How many open buffers have unsaved changes. */
export function dirtyCount(buffers: Map<string, DirtyLike>): number {
  let n = 0;
  for (const b of buffers.values()) if (b.dirty) n++;
  return n;
}

/** The side effects `saveAllDirtyBuffers` delegates to, so the iteration itself stays pure. */
export interface SaveAllDeps<T extends SaveableBuffer> {
  /** Persist a path-bearing buffer; may reject (e.g. the disk write fails). */
  write(buffer: T): Promise<void>;
  /** Persist a path-less scratch buffer (prompts a save-as); owns its own clean/promote bookkeeping. */
  saveScratch(buffer: T): Promise<void>;
  /** Report a failed `write`; the buffer is left dirty and the remaining buffers still save. */
  onError(buffer: T, error: unknown): void;
}

/**
 * Save every dirty buffer. A path-bearing buffer is written via `write` and marked clean; a
 * path-less (scratch) buffer is routed through `saveScratch`. A failed `write` keeps that buffer
 * dirty, is reported via `onError`, and does not stop the others. Returns the number of path-bearing
 * buffers successfully written.
 */
export async function saveAllDirtyBuffers<T extends SaveableBuffer>(
  buffers: Map<string, T>,
  deps: SaveAllDeps<T>,
): Promise<number> {
  let saved = 0;
  for (const buffer of dirtyBuffers(buffers)) {
    if (buffer.path == null) {
      await deps.saveScratch(buffer);
      continue;
    }
    try {
      await deps.write(buffer);
      buffer.dirty = false;
      saved++;
    } catch (error) {
      deps.onError(buffer, error);
    }
  }
  return saved;
}
