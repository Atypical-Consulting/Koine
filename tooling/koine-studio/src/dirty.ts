// Pure helpers over the open-buffer set, factored out of the IDE shell so unsaved-work tracking
// (Save-all, the global dirty indicator, the unload guard) is unit-testable without a DOM or a live
// editor. No imports, no app state — every function is pure over a minimal structural buffer shape
// (the IDE's full `Buffer` in ide.ts is a structural match).

/** The slice of an open buffer these helpers read to decide if it has unsaved changes. */
export interface DirtyLike {
  dirty: boolean;
}

/** A persistable buffer: a real `path` is written to disk. */
export interface SaveableBuffer extends DirtyLike {
  path: string;
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

/**
 * The document title for `count` unsaved files: a `• ` prefix signals unsaved work, like a native
 * editor's modified-title dot. Idempotent — never double-prefixes an already-marked base.
 */
export function titleWithDirty(base: string, count: number): string {
  const clean = base.replace(/^• /, '');
  return count > 0 ? `• ${clean}` : clean;
}

/** The slice of a `BeforeUnloadEvent` the guard touches, so it's testable with a plain fake. */
export interface UnloadEvent {
  preventDefault(): void;
  returnValue: unknown;
}

/**
 * `beforeunload` guard: when `isDirty()` reports unsaved work, cancel the unload (preventDefault +
 * a legacy non-empty `returnValue`) so the browser shows its native "Leave site?" confirmation. A
 * no-op when nothing is dirty, so a clean session closes without friction. Returns whether it
 * blocked the unload (for testability — the browser ignores the return value).
 */
export function handleBeforeUnload(event: UnloadEvent, isDirty: () => boolean): boolean {
  if (!isDirty()) return false;
  event.preventDefault();
  // Legacy requirement: assigning a non-empty returnValue is what triggers the prompt in older
  // Chromium/Firefox; modern engines key off preventDefault().
  event.returnValue = 'You have unsaved changes.';
  return true;
}

/** The side effects `saveAllDirtyBuffers` delegates to, so the iteration itself stays pure. */
export interface SaveAllDeps<T extends SaveableBuffer> {
  /** Persist a buffer; may reject (e.g. the disk write fails). */
  write(buffer: T): Promise<void>;
  /** Report a failed `write`; the buffer is left dirty and the remaining buffers still save. */
  onError(buffer: T, error: unknown): void;
}

/**
 * Save every dirty buffer via `write`, marking each clean. A failed `write` keeps that buffer dirty,
 * is reported via `onError`, and does not stop the others. Returns the count successfully written.
 */
export async function saveAllDirtyBuffers<T extends SaveableBuffer>(
  buffers: Map<string, T>,
  deps: SaveAllDeps<T>,
): Promise<number> {
  let saved = 0;
  for (const buffer of dirtyBuffers(buffers)) {
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
