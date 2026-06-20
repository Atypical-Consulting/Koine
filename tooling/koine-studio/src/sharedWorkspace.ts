// Pure helpers for the in-memory shared workspace — the multi-buffer workspace `importSharedWorkspace`
// builds when the host can't materialize a share link to a real folder (a non-OPFS browser, a transient
// OPFS failure, or the desktop host, which has no materializeWorkspace seam at all). Those buffers have
// no backing store, so their edits must be dirty-tracked and can only be persisted by writing the whole
// workspace out to a user-picked folder. Both functions are pure so the rules are unit-testable without
// a DOM, the editor, or a live host (the wiring in ide.ts consumes them).

/** The slice of an open buffer the dirty-tracking rule reads. */
export interface PathLike {
  path: string | null;
}

/**
 * Whether editing `buf` should mark it dirty. A path-bearing buffer (a real on-disk file) always is.
 * A path-null buffer is dirty-trackable only inside the in-memory shared workspace — there it has no
 * backing store, so edits are at risk; the scratch buffer (also path-null, but auto-persisted to
 * localStorage) is deliberately never marked dirty, hence `inMemoryWorkspace === false` for it.
 */
export function isDirtyTrackable(buf: PathLike, inMemoryWorkspace: boolean): boolean {
  return buf.path != null || inMemoryWorkspace;
}

/**
 * The `targets` that already exist in a destination folder (`existing`), in target order. Empty means
 * the folder is safe to write the workspace into; a non-empty result is a collision the caller surfaces
 * rather than clobbering — mirroring the never-clobber invariant the host's createFile enforces.
 */
export function clashingRelPaths(targets: string[], existing: Iterable<string>): string[] {
  const set = existing instanceof Set ? existing : new Set(existing);
  return targets.filter((t) => set.has(t));
}
