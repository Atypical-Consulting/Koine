// The Assistant's in-memory staging area: when the model proposes full-file edits via the agentic
// write tools, they accumulate HERE rather than touching the workspace directly. The user reviews the
// staged set and applies (or discards) it in one go. A pure-logic module — no DOM, no WASM — so the
// dispatch layer and the review/apply panel can both build on it and unit-test it in isolation.
//
// `initial` is a snapshot of the workspace's current `.koi` files keyed by an OPAQUE `key` — the
// buffer uri for a workspace file (unique even when two roots of a multi-root workspace hold the same
// workspace-relative path, #472). The session reads through to it for any key the model has not (yet)
// staged, so `read()` always reflects the body the model should be revising. The workspace-relative
// path (`relPath`) is only a display + validation label, resolved through the optional `display` map;
// without a `display` entry the key IS the relPath, so single-root/legacy callers behave exactly as
// before the re-keying.

/** Prefix of the synthetic key minted for a file that does not exist in the workspace yet. */
export const NEW_FILE_KEY_PREFIX = 'new:';

/**
 * Mint the session key for a brand-new file (one with no buffer uri yet): `new:<relPath>`. The
 * session resolves such a key's relPath by stripping the prefix, so the safety/extension guards in
 * {@link EditSession.stage} apply to the real path.
 */
export function newFileKey(relPath: string): string {
  return `${NEW_FILE_KEY_PREFIX}${relPath}`;
}

/** One staged full-file edit. `key` is the file's opaque session identity (buffer uri, or a
 *  {@link newFileKey} for a brand-new file); `relPath` is its display/validation label and is NOT
 *  unique across the roots of a multi-root workspace. `isNew` distinguishes a brand-new file from a
 *  revision of an existing workspace file (a key that was NOT among the session's `initial` keys). */
export interface StagedEdit {
  key: string;
  relPath: string;
  body: string;
  isNew: boolean;
}

/** The staging area returned by {@link createEditSession}. */
export interface EditSession {
  /** Keys known to the session: the initial keys (insertion order) then any newly-staged keys
   *  (stage order), deduped. */
  list(): string[];
  /** The staged body if `key` was staged this session, else the initial body, else `null`. */
  read(key: string): string | null;
  /** Stage a full-file body for `key`. Staging the same key again replaces the body. */
  stage(key: string, body: string): void;
  /** Whether `key` is a brand-new file (not among the session's initial workspace files). */
  isNew(key: string): boolean;
  /** One entry per key staged this session, in stage order, each flagged new vs modified. */
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
 * Create an edit-staging area over a snapshot of the current workspace files (`initial`, keyed by the
 * opaque session `key`). `display` maps each key to its workspace-relative path for labels and safety
 * validation; a key without an entry resolves to itself (after stripping a {@link NEW_FILE_KEY_PREFIX}),
 * which is exactly today's single-root behavior where key === relPath. Staged edits live only in this
 * session until applied; nothing here mutates `initial`.
 */
export function createEditSession(
  initial: Record<string, string>,
  display: Record<string, string> = {},
): EditSession {
  const initialKeys = Object.keys(initial);
  const initialSet = new Set(initialKeys);
  // Map preserves insertion (stage) order, which `staged()` and `list()` rely on for determinism.
  const stagedMap = new Map<string, string>();

  /** The display/validation relPath for `key`: the `display` entry, else the key itself (a new-file
   *  key contributes the relPath it was minted from). */
  const resolveRelPath = (key: string): string => {
    const shown = display[key];
    if (shown !== undefined) return shown;
    return key.startsWith(NEW_FILE_KEY_PREFIX) ? key.slice(NEW_FILE_KEY_PREFIX.length) : key;
  };

  return {
    list(): string[] {
      const out = [...initialKeys];
      for (const key of stagedMap.keys()) {
        if (!initialSet.has(key)) {
          out.push(key);
        }
      }
      return out;
    },

    read(key: string): string | null {
      assertSafeRelPath(resolveRelPath(key));
      if (stagedMap.has(key)) {
        return stagedMap.get(key)!;
      }
      return key in initial ? initial[key] : null;
    },

    stage(key: string, body: string): void {
      // Guard the RESOLVED relPath — for a brand-new file that is the path the apply step will
      // create, so an unsafe or non-model path must be rejected here, at stage time.
      const relPath = resolveRelPath(key);
      assertSafeRelPath(relPath);
      // The assistant edits the workspace's `.koi` model, not arbitrary project files — reject any other
      // extension so a write tool can't create/overwrite a README, lockfile, etc. inside the folder.
      if (!relPath.toLowerCase().endsWith('.koi')) {
        throw new Error(`Unsafe relPath (only .koi files can be edited): ${relPath}`);
      }
      stagedMap.set(key, body);
    },

    isNew(key: string): boolean {
      return !initialSet.has(key);
    },

    staged(): StagedEdit[] {
      return [...stagedMap.entries()].map(([key, body]) => ({
        key,
        relPath: resolveRelPath(key),
        body,
        isNew: !initialSet.has(key),
      }));
    },

    clear(): void {
      stagedMap.clear();
    },
  };
}
