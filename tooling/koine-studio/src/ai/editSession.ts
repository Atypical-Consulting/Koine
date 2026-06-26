// The Assistant's in-memory staging area: when the model proposes full-file edits via the agentic
// write tools, they accumulate HERE rather than touching the workspace directly. The user reviews the
// staged set and applies (or discards) it in one go. A pure-logic module — no DOM, no WASM — so the
// dispatch layer and the review/apply panel can both build on it and unit-test it in isolation.
//
// `initial` is a snapshot of the workspace's current `.koi` files keyed by relPath; the session reads
// through to it for any relPath the model has not (yet) staged, so `read()` always reflects the body
// the model should be revising.

/** One staged full-file edit. `isNew` distinguishes a brand-new file from a revision of an existing
 *  workspace file (a relPath that was NOT among the session's `initial` keys). */
export interface StagedEdit {
  relPath: string;
  body: string;
  isNew: boolean;
}

/** The staging area returned by {@link createEditSession}. */
export interface EditSession {
  /** RelPaths known to the session: the initial keys (insertion order) then any newly-staged keys
   *  (stage order), deduped. */
  list(): string[];
  /** The staged body if `relPath` was staged this session, else the initial body, else `null`. */
  read(relPath: string): string | null;
  /** Stage a full-file body for `relPath`. Staging the same relPath again replaces the body. */
  stage(relPath: string, body: string): void;
  /** Whether `relPath` is a brand-new file (not among the session's initial workspace files). */
  isNew(relPath: string): boolean;
  /** One entry per relPath staged this session, in stage order, each flagged new vs modified. */
  staged(): StagedEdit[];
  /** Empty the staging area: `staged()` → `[]` and `read()` falls back to `initial` again. */
  clear(): void;
}

/**
 * Reject relPaths that escape the workspace root: absolute paths (a leading `/`, or a Windows drive
 * like `C:\`) and any parent-traversal (`..`) segment. Backslashes are normalized to forward slashes
 * first so a Windows-style path is checked the same way. Throws an `Error` describing the rejection.
 */
export function assertSafeRelPath(relPath: string): void {
  if (!relPath.trim()) {
    throw new Error('Unsafe relPath (empty path).');
  }
  const normalized = relPath.replace(/\\/g, '/');
  if (normalized.startsWith('/')) {
    throw new Error(`Unsafe relPath (absolute path): ${relPath}`);
  }
  if (/^[A-Za-z]:\//.test(normalized)) {
    throw new Error(`Unsafe relPath (Windows drive path): ${relPath}`);
  }
  if (normalized.split('/').some((segment) => segment === '..')) {
    throw new Error(`Unsafe relPath (parent traversal): ${relPath}`);
  }
}

/**
 * Create an edit-staging area over a snapshot of the current workspace files (`initial`, keyed by
 * relPath). Staged edits live only in this session until applied; nothing here mutates `initial`.
 */
export function createEditSession(initial: Record<string, string>): EditSession {
  const initialKeys = Object.keys(initial);
  const initialSet = new Set(initialKeys);
  // Map preserves insertion (stage) order, which `staged()` and `list()` rely on for determinism.
  const stagedMap = new Map<string, string>();

  return {
    list(): string[] {
      const out = [...initialKeys];
      for (const relPath of stagedMap.keys()) {
        if (!initialSet.has(relPath)) {
          out.push(relPath);
        }
      }
      return out;
    },

    read(relPath: string): string | null {
      assertSafeRelPath(relPath);
      if (stagedMap.has(relPath)) {
        return stagedMap.get(relPath)!;
      }
      return relPath in initial ? initial[relPath] : null;
    },

    stage(relPath: string, body: string): void {
      assertSafeRelPath(relPath);
      // The assistant edits the workspace's `.koi` model, not arbitrary project files — reject any other
      // extension so a write tool can't create/overwrite a README, lockfile, etc. inside the folder.
      if (!relPath.toLowerCase().endsWith('.koi')) {
        throw new Error(`Unsafe relPath (only .koi files can be edited): ${relPath}`);
      }
      stagedMap.set(relPath, body);
    },

    isNew(relPath: string): boolean {
      return !initialSet.has(relPath);
    },

    staged(): StagedEdit[] {
      return [...stagedMap.entries()].map(([relPath, body]) => ({
        relPath,
        body,
        isNew: !initialSet.has(relPath),
      }));
    },

    clear(): void {
      stagedMap.clear();
    },
  };
}
