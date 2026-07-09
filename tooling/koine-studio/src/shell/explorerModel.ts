// Pure, DOM-free data core for the workspace explorer (#989 task 1): the filter-visibility,
// visible-row-flattening, ancestry and reveal-by-context logic ported verbatim out of
// `explorer.ts`'s imperative render pipeline, with every DOM/store touch stripped out. These
// functions take the same `ExplorerRootGroup[]` shape the explorer already renders from and
// return plain data — no `HTMLElement`, no closures over mutable render state — so a future
// Preact `ExplorerPanel` (or anything else) can consume them directly, and so this logic is
// unit-testable without jsdom.
//
// `explorer.ts` itself is intentionally left untouched here (its own analyze/visibleItems/
// findFileForContext keep working exactly as before); this module is an ADDITIVE extraction that
// later migration tasks will switch the render path over to.
import type { FsEntry } from '@/host';
import type { ExplorerRootGroup } from '@/shell/explorer';

/** Result of {@link analyze}: everything a render pass needs from one filter/active pass over the tree. */
export interface ExplorerAnalysis {
  /** Tokens to render under the active filter (unused when the filter is empty). */
  visible: Set<string>;
  /** Every directory token currently in the tree, used to prune stale entries from a `collapsed` set. */
  liveDirs: Set<string>;
  /** Entries (file OR dir) whose name matches the filter — what the filter-count chip reports. */
  matchCount: number;
  /** The active file and its ancestor directory tokens (for auto-reveal), or null. */
  active: { token: string; ancestors: string[] } | null;
}

/**
 * ONE pass over `groups` computing filter visibility, live dir tokens, the filter match count and
 * the active file + its ancestor chain — ported from `explorer.ts`'s internal `analyze()`
 * (formerly around explorer.ts:266-293; the file has drifted since, see the current `analyze`
 * near its filtering section). A directory whose OWN name matches reveals its whole subtree (so a
 * matched folder isn't shown empty — "matched-dir-reveals-subtree"); the count includes matched
 * dirs, not just files ("dir-counted-in-matches").
 *
 * `filter` is matched case-insensitively and may be passed in any case/with surrounding
 * whitespace — it is trimmed and lowercased here, mirroring the original caller's
 * `filterInput.value.trim().toLowerCase()`. `isActive` mirrors `ExplorerCallbacks.isActive`.
 */
export function analyze(
  groups: readonly ExplorerRootGroup[],
  filter: string,
  isActive: (fileToken: string) => boolean,
): ExplorerAnalysis {
  const visible = new Set<string>();
  const liveDirs = new Set<string>();
  let matchCount = 0;
  let active: { token: string; ancestors: string[] } | null = null;

  const f = filter.trim().toLowerCase();
  const filtering = f !== '';
  const nameMatches = (entry: FsEntry): boolean => entry.name.toLowerCase().includes(f);

  // Returns whether `e` (or a descendant) is visible under the filter. `ancestorMatched` is true when
  // an ancestor directory's own name matched — that reveals the entire subtree beneath it.
  const walk = (e: FsEntry, ancestors: string[], ancestorMatched: boolean): boolean => {
    if (e.kind === 'dir') liveDirs.add(e.token);
    const selfMatch = filtering && nameMatches(e);
    if (selfMatch) matchCount++;
    if (e.kind === 'file' && !active && isActive(e.token)) active = { token: e.token, ancestors };

    const childAncestors = e.kind === 'dir' ? [...ancestors, e.token] : ancestors;
    let descendantVisible = false;
    for (const c of e.children ?? []) {
      if (walk(c, childAncestors, ancestorMatched || selfMatch)) descendantVisible = true;
    }

    const isVisible = !filtering || selfMatch || descendantVisible || ancestorMatched;
    if (filtering && isVisible) visible.add(e.token);
    return isVisible;
  };
  for (const g of groups) for (const e of g.entries) walk(e, [], false);
  return { visible, liveDirs, matchCount, active };
}

/** One flattened, ordered visible row — the data-only equivalent of a rendered `<li role="treeitem">`. */
export interface ExplorerFlatRow {
  token: string;
  kind: FsEntry['kind'];
  /** 1-based ARIA tree level (matches the `aria-level` the DOM build assigns). */
  level: number;
  /** The immediate containing directory's token, or null for a top-level (group-root) entry. */
  parentToken: string | null;
}

/**
 * The ordered list of visible rows across every group — ported from `explorer.ts`'s
 * `visibleItems()` DOM walk (formerly around explorer.ts:481-502; current file has drifted, see
 * the walk over `tree`/`.explorer-group-items`/`.explorer-children`). Group headers never produce
 * a row (multi-root groups are transparent, matching the DOM walk stepping through
 * `.explorer-group` wrappers without emitting one for the wrapper itself); entries across
 * multiple root groups are concatenated in group order.
 *
 * Filter-visibility uses the same rules as {@link analyze} (matched-dir-reveals-subtree,
 * dir-counted-in-matches): entries outside the filter's `visible` set are dropped, and while a
 * filter is active every directory is treated as force-expanded (mirrors the DOM build's
 * `expanded = filterText ? true : !collapsed.has(token)`), so `collapsed` is only honoured when
 * `filter` is empty.
 */
export function flattenVisible(
  groups: readonly ExplorerRootGroup[],
  collapsed: ReadonlySet<string>,
  filter: string,
): ExplorerFlatRow[] {
  const { visible } = analyze(groups, filter, () => false);
  const filtering = filter.trim() !== '';

  const out: ExplorerFlatRow[] = [];
  const walk = (e: FsEntry, level: number, parentToken: string | null): void => {
    if (filtering && !visible.has(e.token)) return;
    out.push({ token: e.token, kind: e.kind, level, parentToken });
    if (e.kind === 'dir') {
      const expanded = filtering || !collapsed.has(e.token);
      if (!expanded) return;
      for (const c of e.children ?? []) walk(c, level + 1, e.token);
    }
  };
  for (const g of groups) for (const e of g.entries) walk(e, 1, null);
  return out;
}

/**
 * token → immediate-parent-token ancestry for every entry across every group (null for a
 * top-level/group-root entry) — powers drop-validity (self/descendant/current-parent rejection,
 * mirroring `explorer.ts`'s DOM-containment `canDropTo` checks) and ArrowLeft-to-parent for a
 * future keyboard-nav implementation.
 */
export function parentMapOf(groups: readonly ExplorerRootGroup[]): Map<string, string | null> {
  const map = new Map<string, string | null>();
  const walk = (e: FsEntry, parentToken: string | null): void => {
    map.set(e.token, parentToken);
    for (const c of e.children ?? []) walk(c, e.token);
  };
  for (const g of groups) for (const e of g.entries) walk(e, null);
  return map;
}

/**
 * The directory a New File/New Folder (or a Rename lookup) targets for `entry`, given its containing
 * directory token `parentDir` — ported verbatim from `explorer.ts`'s `parentDirOf` (#989 task 4): the
 * entry itself when it IS a directory (a "New File" inside a right-clicked folder lands in that folder),
 * otherwise `parentDir` (a right-clicked file's New File/Folder lands beside it, in its container).
 * `parentDir` is normally resolved via {@link indexEntries}'s `parentDirs` map (or, for a row a caller
 * is already walking, the same value `indexEntries` would have computed at that point in the walk).
 */
export function parentDirOf(entry: FsEntry, parentDir: string): string {
  return entry.kind === 'dir' ? entry.token : parentDir;
}

/**
 * `entries`: token → FsEntry. `parentDirs`: token → the exact `parentDir` `explorer.ts`'s `buildItem`
 * threads down to that entry — the owning GROUP's root for a top-level entry, the containing directory's
 * token otherwise. Unlike {@link parentMapOf} (null at the top level, for ancestry/ArrowLeft-ascend),
 * `parentDirs` is never null, because it feeds {@link parentDirOf} directly (which needs a real token to
 * fall back to for a top-level FILE row).
 *
 * Powers the keyboard-triggered (#989 task 4) Delete-confirm and ContextMenu-key row-menu flows in
 * `ExplorerPanel`: the roving-tabindex row order only carries a bare token, not the full entry object a
 * right-click's own closure already has for free, so those two paths look both up here instead.
 */
export interface ExplorerEntryIndex {
  entries: Map<string, FsEntry>;
  parentDirs: Map<string, string>;
}
export function indexEntries(groups: readonly ExplorerRootGroup[]): ExplorerEntryIndex {
  const entries = new Map<string, FsEntry>();
  const parentDirs = new Map<string, string>();
  const walk = (e: FsEntry, parentDir: string): void => {
    entries.set(e.token, e);
    parentDirs.set(e.token, parentDir);
    for (const c of e.children ?? []) walk(c, e.token);
  };
  for (const g of groups) for (const e of g.entries) walk(e, g.root);
  return { entries, parentDirs };
}

/**
 * A name is one path segment. Reject path separators and the `.`/`..` traversal names so an inline
 * create/rename input can't escape the folder (or, for rename, become a cross-directory move) from a
 * single-name input — ported verbatim from `explorer.ts`'s `invalidSegment` (#989 task 5) so the two
 * inline-edit implementations (the old imperative one and `ExplorerPanel`'s controlled-input one) share
 * ONE definition instead of drifting.
 */
export function invalidSegment(name: string): boolean {
  return name.includes('/') || name.includes('\\') || name === '.' || name === '..';
}

/**
 * The bounded-context name a source file denotes — its `.koi` stem, lowercased — or `null` for a
 * non-`.koi` file. Ported verbatim from `explorer.ts`'s private `koiStem` (ADR 0009 / #1188): one
 * `.koi` file is one bounded context (the stem convention {@link findFileForContext} also uses), so
 * the stem is what the active-context scope emphasis ({@link scopeMatchOf}, and `ExplorerPanel`'s
 * own per-row `is-scoped`/`dim` decision) matches against. Exported so both stay in lockstep with
 * ONE definition instead of drifting.
 */
export function koiStem(name: string): string | null {
  const lower = name.toLowerCase();
  return lower.endsWith('.koi') ? lower.slice(0, -'.koi'.length) : null;
}

/**
 * Whether SOME file across `groups` has a `.koi` stem equal to `activeContext` — ported from
 * `explorer.ts`'s private `analyze()`'s `scopeMatch` computation (ADR 0009 / #1188), as a small
 * SEPARATE pure helper rather than widening this module's own {@link analyze}'s return shape (six
 * other #989 tasks already depend on its current `ExplorerAnalysis` contract).
 *
 * This gates the whole active-context scope emphasis: a scope naming no present `.koi` file must be
 * a genuine no-op (nothing dimmed), not a whole-tree dim — so a caller (`ExplorerPanel`) only applies
 * `is-scoped`/`dim` to any row when this returns `true`. `activeContext` is expected already
 * normalized (trimmed + lowercased) by the caller, mirroring `explorer.ts`'s `setActiveContext`.
 */
export function scopeMatchOf(groups: readonly ExplorerRootGroup[], activeContext: string): boolean {
  const matches = (e: FsEntry): boolean =>
    (e.kind === 'file' && koiStem(e.name) === activeContext) || (e.children ?? []).some(matches);
  return groups.some((g) => g.entries.some(matches));
}

/**
 * Find the file backing a bounded context by matching its STEM (the basename minus the `.koi`
 * extension) case-insensitively — the "Reveal in Files" (#453) convention that one `.koi` file is
 * one bounded context. Ported from `explorer.ts`'s `findFileForContext` (formerly around
 * explorer.ts:1211-1228). Returns the file token + its ancestor directory tokens (to expand on
 * the way to reveal it), or null when `context` is blank or no file's stem matches.
 */
export function findFileForContext(
  groups: readonly ExplorerRootGroup[],
  context: string,
): { token: string; ancestors: string[] } | null {
  const target = context.trim().toLowerCase();
  if (!target) return null;
  let hit: { token: string; ancestors: string[] } | null = null;
  const walk = (e: FsEntry, ancestors: string[]): void => {
    if (hit) return;
    if (e.kind === 'file') {
      const lower = e.name.toLowerCase();
      const stem = lower.endsWith('.koi') ? lower.slice(0, -'.koi'.length) : lower;
      if (stem === target) hit = { token: e.token, ancestors };
      return;
    }
    const childAncestors = [...ancestors, e.token];
    for (const c of e.children ?? []) walk(c, childAncestors);
  };
  for (const g of groups) for (const e of g.entries) walk(e, []);
  return hit;
}
