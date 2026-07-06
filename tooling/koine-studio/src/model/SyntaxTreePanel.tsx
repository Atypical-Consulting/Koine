import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import type { SyntaxTreeNode } from '@/lsp/protocol';
import type { KoineLsp } from '@/lsp/lsp';

// The Syntax Tree panel (issue #890): the right-rail view of the active document's raw parse tree — one
// row per grammar construct (a `ValueObjectDecl`, `ContextNode`, `Member`, `BinaryExpr`, …), rendered as
// a keyboard-navigable WAI-ARIA tree. Like {@link SourceControlPanel} it mirrors the other model panels
// (a Preact functional component with preact/hooks; the project's `koi-…` class vocabulary, no Tailwind)
// and, also like it, OWNS its own async fetch: the tree isn't in the joined model index, so the panel
// pulls it straight from the {@link SyntaxTreeSource} it's handed. When the fetch resolves null (an
// unknown/absent active uri) or an empty tree, it paints an empty state instead of blanking or crashing.
//
// Error-recovery nodes are first-class: `isError` / `isMissing` rows get a distinct modifier class and an
// accessible "(error)" / "(missing)" suffix on the row's name, so a half-typed file's recovered tree
// stays legible rather than reading like valid structure.
//
// SCOPE (this task, #890 Task 4): PRESENTATION + own fetch only. Task 5 wires the panel into the right
// rail and bumps `revision` on the debounced doc-changed invalidation; Task 6 adds bidirectional
// source ↔ tree navigation (click a row → jump to its span; caret in source → highlight the row). The
// row structure below leaves room for a later `onNodeClick(node)` / `selectedKey` without a rewrite.

/**
 * The slice of {@link KoineLsp} the panel calls — narrowed to just `syntaxTree` so a test can hand it a
 * tiny fake object (no full client). The right-rail controller passes the real `lsp`, which structurally
 * satisfies this.
 */
export type SyntaxTreeSource = Pick<KoineLsp, 'syntaxTree'>;

/** The root's path key. Every node's key is its index-path from the root, e.g. `0/1/2` (root → child 1 →
 *  grandchild 2). Stable per tree shape, which is all the expand/roving-focus bookkeeping needs. */
const ROOT_KEY = '0';

/** The default-expanded rows: the `KoineModel` root and its top-level context children — deeper nodes
 *  start collapsed so a large tree stays responsive (expand-on-demand). */
function defaultExpanded(root: SyntaxTreeNode): Set<string> {
  const keys = new Set<string>([ROOT_KEY]);
  root.children.forEach((_, i) => keys.add(`${ROOT_KEY}/${i}`));
  return keys;
}

/** Walk the tree to the node at an index-path key (`0/1/2`), or null if the path no longer resolves. */
function nodeAtKey(root: SyntaxTreeNode, key: string): SyntaxTreeNode | null {
  const parts = key.split('/');
  let node: SyntaxTreeNode | undefined = root; // parts[0] is the root itself
  for (let i = 1; i < parts.length; i++) {
    node = node?.children[Number(parts[i])];
    if (!node) return null;
  }
  return node ?? null;
}

/** Do two nodes look like the SAME construct? The index-path key is only shape-stable, so after a
 *  rebuild a bare key match can land on a different node if an earlier sibling was inserted/removed;
 *  matching `kind` + `name` rejects that so the roving tab stop is only restored onto the node the
 *  keyboard user actually left it on. */
function sameIdentity(a: SyntaxTreeNode, b: SyntaxTreeNode): boolean {
  return a.kind === b.kind && a.name === b.name;
}

/** True when a node's OWN raw span contains the 1-based caret `(line, col)`:
 *  `(span.line, span.column) <= (line, col) < (span.endLine, span.endColumn)` — lexicographic on
 *  line-then-column, end-EXCLUSIVE. All-zero / span-less nodes (the root has a `line:0` span) contain
 *  nothing, so they never match. */
function spanContainsCaret(span: SyntaxTreeNode['span'], line: number, col: number): boolean {
  if (span.line === 0) return false; // the all-zero root span / a span-less node contains nothing
  const afterStart = line > span.line || (line === span.line && col >= span.column);
  const beforeEnd = line < span.endLine || (line === span.endLine && col < span.endColumn);
  return afterStart && beforeEnd;
}

/**
 * The DEEPEST node (with its index-path key) whose OWN span contains the caret, or null when nothing
 * does. This is the client-side {@link `SyntaxGraph.FindNode(offset)`} heuristic: `span` is each node's
 * OWN range, not the bounding span the server would union over a subtree, so this resolves deepest
 * own-span containment — the v1 fidelity. Ties (equal depth) resolve to the first in pre-order.
 */
export function deepestContaining(
  root: SyntaxTreeNode,
  line: number,
  col: number,
): { key: string; node: SyntaxTreeNode } | null {
  let best: { key: string; node: SyntaxTreeNode } | null = null;
  let bestDepth = -1;
  const walk = (node: SyntaxTreeNode, key: string, depth: number): void => {
    if (depth > bestDepth && spanContainsCaret(node.span, line, col)) {
      best = { key, node };
      bestDepth = depth;
    }
    node.children.forEach((c, i) => walk(c, `${key}/${i}`, depth + 1));
  };
  walk(root, ROOT_KEY, 0);
  return best;
}

/** A new expanded-set that also has every ANCESTOR of `key` expanded (so the node at `key` renders). The
 *  key itself is NOT force-expanded — only the path down to it. Returns `prev` unchanged when every
 *  ancestor is already expanded, so the caller's `setExpanded` can bail without a re-render. */
function withAncestorsExpanded(prev: Set<string>, key: string): Set<string> {
  const next = new Set(prev);
  for (let i = key.indexOf('/'); i !== -1; i = key.indexOf('/', i + 1)) next.add(key.slice(0, i));
  return next.size === prev.size ? prev : next;
}

/** A single-line, whitespace-collapsed, length-capped preview of a leaf node's source text. */
function previewLeaf(leaf: string): string {
  const t = leaf.replace(/\s+/g, ' ').trim();
  return t.length > 40 ? `${t.slice(0, 39)}…` : t;
}

/** The row's isolated accessible name: `kind [name][: leaf] [(error)][(missing)]`. Set as the treeitem's
 *  `aria-label` so the nested `role="group"` spine isn't concatenated into the announced name, and every
 *  meaningful bit (kind, name, leaf preview, recovery markers) is still spoken. */
function accessibleName(node: SyntaxTreeNode): string {
  let s = node.name ? `${node.kind} ${node.name}` : node.kind;
  if (node.children.length === 0 && node.leaf) s += `: ${previewLeaf(node.leaf)}`;
  if (node.isError) s += ' (error)';
  if (node.isMissing) s += ' (missing)';
  return s;
}

// --- windowed virtualization (#1098) --------------------------------------------------------------
// A large or deeply-expanded tree is FLATTENED to an ordered list of the currently-visible (expanded)
// rows, and only the rows intersecting the viewport are mounted; the off-window rows above and below are
// represented as scroll-container padding, so the region still scrolls as if every row were present.
// Hierarchy that the old nested `role="group"` markup conveyed structurally is now carried on each flat
// `role="treeitem"` by `aria-level`/`aria-setsize`/`aria-posinset` (the WAI-ARIA flat-tree pattern).
// Below the threshold the whole list renders in normal flow, so a small tree (the common case) is
// unchanged.

/** One flattened visible row: its index-path key, the node, its 1-based depth, and its position among
 *  siblings — enough to render an honest flat `treeitem` with `aria-level`/`aria-setsize`/`aria-posinset`. */
export interface Row {
  key: string;
  node: SyntaxTreeNode;
  level: number;
  setSize: number;
  posInSet: number;
  hasChildren: boolean;
  isExpanded: boolean;
}

/** Fallback row height (px) for the window math until the real (font-scaled) row height is measured from
 *  a mounted row — used under happy-dom / a pre-layout paint where `offsetHeight` is 0. */
const ROW_HEIGHT = 24;
/** At/below this many visible rows, render every row (windowing is pure overhead for a small tree). */
const VIRTUALIZE_THRESHOLD = 100;
/** Rows rendered above/below the viewport so a fast scroll doesn't flash blank. */
const OVERSCAN = 8;
/** Window size (in rows) when the container height can't be measured yet (pre-layout / happy-dom tests). */
const FALLBACK_VIEWPORT_ROWS = 40;

/** Pre-order flatten of the visible (expanded) rows. A collapsed node contributes its own row but none of
 *  its descendants — exactly the set the panel renders and the arrow keys traverse. */
export function flattenVisible(root: SyntaxTreeNode, expanded: Set<string>): Row[] {
  const rows: Row[] = [];
  const walk = (node: SyntaxTreeNode, key: string, level: number, setSize: number, posInSet: number): void => {
    const hasChildren = node.children.length > 0;
    const isExpanded = hasChildren && expanded.has(key);
    rows.push({ key, node, level, setSize, posInSet, hasChildren, isExpanded });
    if (isExpanded) {
      node.children.forEach((c, i) => walk(c, `${key}/${i}`, level + 1, node.children.length, i + 1));
    }
  };
  walk(root, ROOT_KEY, 1, 1, 1);
  return rows;
}

/**
 * The ancestor chain (root..parent) of the row at index-path `key`, as renderable {@link Row}s that carry the
 * SAME `aria-level`/`aria-setsize`/`aria-posinset` those ancestors have inline. Empty for a root (a `key` with
 * no `/`). This is the derivation behind the sticky ancestors band (#1106): when a windowed flat tree scrolls
 * deep, the window-top row's ancestors have scrolled out of the mounted slice, so an AT enumerating the raw
 * DOM sees `aria-level=N` rows with no level-1..N-1 parents. Re-materialising that chain restores the levels.
 *
 * Derived straight from the tree + `key` in O(depth) — deliberately NOT an O(n) scan of the flattened rows —
 * so the band can recompute on every window-top change without reintroducing the per-scroll O(n) work that
 * #1098's virtualization exists to avoid (a deep row in a huge flat sibling list is ~n rows past its
 * ancestors, so a backward scan would be O(n)). `expanded` only fills each band row's `isExpanded` (every
 * ancestor is expanded, since its descendant is visible); it never changes which rows are returned. A key that
 * no longer resolves (a shrunk/rebuilt tree after a refetch) yields the ancestors up to the break, never a
 * stale node.
 */
export function ancestorsOf(root: SyntaxTreeNode, key: string, expanded: Set<string>): Row[] {
  const out: Row[] = [];
  for (let slash = key.indexOf('/'); slash !== -1; slash = key.indexOf('/', slash + 1)) {
    const ancKey = key.slice(0, slash);
    const node = nodeAtKey(root, ancKey);
    if (!node) break; // a path that no longer resolves contributes no (stale) band row
    const cut = ancKey.lastIndexOf('/');
    const parent = cut === -1 ? null : nodeAtKey(root, ancKey.slice(0, cut));
    const hasChildren = node.children.length > 0;
    out.push({
      key: ancKey,
      node,
      level: ancKey.split('/').length, // '0' → 1, '0/0' → 2, … matching flattenVisible's 1-based depth
      setSize: parent ? parent.children.length : 1,
      posInSet: cut === -1 ? 1 : Number(ancKey.slice(cut + 1)) + 1,
      hasChildren,
      isExpanded: hasChildren && expanded.has(ancKey),
    });
  }
  return out;
}

/** The half-open range `[first, last)` of row indices to mount for a scroll offset + viewport height
 *  (padded by overscan). Shared by the render and the keyboard/caret nav so "is this row mounted?" agrees
 *  everywhere. Because each row sits at content-y `index * rowHeight`, the offset maps directly. `first`
 *  is clamped to `total - visibleCount` so a STALE `scrollTop` (e.g. left over from a larger tree that
 *  just shrank) can never push the window past the end and blank the panel. */
function windowRange(
  total: number,
  scrollTop: number,
  viewportH: number,
  rowHeight: number,
  bandHeight = 0,
): { first: number; last: number } {
  // The sticky ancestors band (#1106) sits ABOVE the window and covers `bandHeight` of the viewport, so the
  // window only needs to fill the space BELOW it — subtract it so the mounted-row count stays bounded and the
  // band never pushes extra rows into the DOM. `bandHeight` is 0 whenever the band is absent or unmeasured
  // (happy-dom / a pre-layout paint), which recovers the pre-#1106 math exactly.
  const viewport = Math.max(rowHeight, (viewportH || rowHeight * FALLBACK_VIEWPORT_ROWS) - bandHeight);
  const visibleCount = Math.ceil(viewport / rowHeight) + OVERSCAN * 2;
  const maxFirst = Math.max(0, total - visibleCount);
  const first = Math.min(maxFirst, Math.max(0, Math.floor(scrollTop / rowHeight) - OVERSCAN));
  const last = Math.min(total, first + visibleCount);
  return { first, last };
}

export function SyntaxTreePanel(props: {
  source: SyntaxTreeSource;
  /**
   * Bumped by the controller to force a re-fetch (Task 5 wires it to the debounced doc-changed
   * invalidation). Optional — omitted, the panel just fetches once on mount.
   */
  revision?: number;
  /**
   * Tree → editor (#890): fires when a row is selected (clicked, or Enter on a non-expandable row), with
   * that node — the controller jumps the editor to `node.span`. Optional so the panel renders standalone.
   */
  onNodeClick?: (node: SyntaxTreeNode) => void;
  /**
   * Editor → tree (#890): the editor's 1-based caret. The panel highlights the DEEPEST node whose OWN
   * span contains it (auto-expanding its ancestors and scrolling it into view). Omitted / out-of-range →
   * no caret-driven highlight (a click selection, if any, is left untouched).
   */
  caret?: { line: number; column: number };
}): JSX.Element {
  const { source, onNodeClick, caret } = props;

  // `undefined` until the first fetch settles (loading); then the fetched node or `null` (empty).
  const [tree, setTree] = useState<SyntaxTreeNode | null | undefined>(undefined);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // The roving-tabindex active row: exactly one visible treeitem is tabbable at a time (one tab stop for
  // the whole tree). `null` falls back to the root, so a fresh tree is always reachable by Tab.
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  // The single "active" (highlighted) node, driven by BOTH a row click (tree → editor) and a caret move
  // (editor → tree): exactly one row wears `--current` + `aria-current` at a time. Distinct from
  // `focusedKey` (the keyboard tab stop) — selecting/highlighting isn't the same as being the tab stop.
  const [activeKey, setActiveKey] = useState<string | null>(null);
  // Windowing state (#1098): the live scroll offset drives which slice of the flattened rows is mounted;
  // the viewport height and the (measured) row height size the window. viewportH/rowHeight fall back to
  // fixed defaults under happy-dom / a pre-layout paint (no layout → 0); scrollTop stays 0 for a small
  // (unwindowed) tree.
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(0);
  const [rowHeight, setRowHeight] = useState(ROW_HEIGHT);
  // The measured pixel height of the sticky ancestors band (#1106), subtracted from the viewport so the
  // window math stays bounded (see windowRange). 0 when the band is absent or under happy-dom (no layout),
  // which recovers the pre-#1106 window exactly.
  const [bandHeight, setBandHeight] = useState(0);
  // Deferred roving focus (#1098): moving focus onto a row currently OUTSIDE the render window can't focus
  // it synchronously — it isn't mounted yet. We record the target key; an effect focuses it on the next
  // render, once the scroll has pulled it into the window.
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  const bandRef = useRef<HTMLDivElement>(null);

  // The one source of truth for "which rows are visible", memoised so it is walked once per (tree,
  // expanded) change — NOT re-walked on every scroll frame, keydown, or caret move (the windowing that
  // makes big trees smooth must not itself reintroduce per-frame O(n) work).
  const rows = useMemo<Row[]>(() => (tree ? flattenVisible(tree, expanded) : []), [tree, expanded]);

  // The mounted window over the flattened rows (#1098), memoised so the tree isn't re-walked on every scroll
  // frame — it recomputes only when the offset/measurements or the row set change. Small (≤ threshold) trees
  // render every row (virtualize=false). Computed here (before the loading/empty early returns) so the
  // ancestor-band memo below can key off the window top while the hook order stays stable.
  const windowSlice = useMemo(() => {
    const count = rows.length;
    if (count <= VIRTUALIZE_THRESHOLD) return { first: 0, last: count, virtualize: false };
    return { ...windowRange(count, scrollTop, viewportH, rowHeight, bandHeight), virtualize: true };
  }, [rows, scrollTop, viewportH, rowHeight, bandHeight]);
  const { first, last, virtualize } = windowSlice;

  // The sticky ancestors band (#1106): the ancestor chain (root..parent) of the window-top row, so a windowed
  // flat tree keeps an unbroken aria-level chain in the DOM even when the real ancestors have scrolled out of
  // the mounted slice. Memoised on the window top + the row set (which changes with the tree/expansion), so it
  // recomputes only when the top row or the tree identity changes — never per scroll frame within one window.
  // Empty unless virtualized and the window top is below a root (shallow/at-top trees render exactly as before).
  const ancestorPath = useMemo<Row[]>(
    () => (virtualize && tree && rows.length > 0 ? ancestorsOf(tree, rows[first].key, expanded) : []),
    [virtualize, first, tree, rows, expanded],
  );

  // A live mirror of the roving tab stop and the node it points at, so the async fetch resolve below can
  // read the CURRENT tab stop rather than the effect closure's stale capture (#1097). Assigned every
  // render — cheaper than an effect and always up to date by the time a microtask-resolved fetch reads it.
  const focusedRef = useRef<{ key: string | null; node: SyntaxTreeNode | null }>({ key: null, node: null });
  focusedRef.current = {
    key: focusedKey,
    node: focusedKey && tree ? nodeAtKey(tree, focusedKey) : null,
  };

  // A one-shot request to re-focus the restored row after a refetch commit (#1097). The fetch resolve
  // sets the key + bumps `refocusTick` ONLY when keyboard focus was inside the tree at rebuild time, so
  // the effect below re-homes an active keyboard user onto the preserved row without ever STEALING focus
  // when it was elsewhere. Making the a11y guarantee explicit here (rather than leaning on Preact's
  // incidental positional DOM reuse) keeps it robust across future reconciliation changes.
  const refocusKeyRef = useRef<string | null>(null);
  const [refocusTick, setRefocusTick] = useState(0);

  // The single fetch path: pull the active document's tree on mount and whenever the source or the
  // controller's `revision` changes. The `alive` latch guards against both an unmount-stale resolve and
  // an out-of-order response — a superseded fetch (revision bumped again) has its cleanup flip `alive`
  // false, so its late resolve is dropped. A failed/absent fetch drops to the empty state, never throws.
  // NOTE (Task 5): the real debounced doc-changed trigger lives in the controller; here we just depend on
  // `revision`.
  useEffect(() => {
    let alive = true;
    void Promise.resolve()
      .then(() => source.syntaxTree())
      .then((t) => {
        if (!alive) return;
        // Whether the keyboard user was actually parked inside the tree at rebuild time — read BEFORE the
        // state updates re-render. Gates the DOM re-focus below so we never yank focus in from elsewhere.
        const wasFocusedInTree = !!treeRef.current?.contains(document.activeElement);
        // Preserve the roving tab stop across the rebuild (#1097): keep it on the previously-focused
        // node when the SAME index-path still resolves to a node of the same identity in the new tree
        // (a typing edit that left it intact); otherwise fall back to the root. Re-expand its ancestors
        // so the restored row actually renders.
        const prev = focusedRef.current;
        const hit = t && prev.key ? nodeAtKey(t, prev.key) : null;
        const restore = hit && prev.node && sameIdentity(hit, prev.node) ? prev.key : null;
        setTree(t ?? null);
        setExpanded(
          t ? (restore ? withAncestorsExpanded(defaultExpanded(t), restore) : defaultExpanded(t)) : new Set(),
        );
        setFocusedKey(restore); // preserved tab stop, or null → the (new) root
        setActiveKey(null); // drop any stale highlight; the caret effect re-derives it for the new tree
        setScrollTop(0); // a NEW (possibly smaller) tree scrolls to the top — never keep a stale offset
        // Only when focus was in the tree AND we actually restored a row: re-home focus onto it after the
        // commit (the effect below), so an active keyboard user isn't dropped to <body> by the rebuild.
        // (The refocus effect scrolls a restored off-window row back into the mounted slice first.)
        if (restore && wasFocusedInTree) {
          refocusKeyRef.current = restore;
          setRefocusTick((n) => n + 1);
        }
      })
      .catch(() => {
        if (!alive) return;
        setTree(null);
        setExpanded(new Set());
        setFocusedKey(null);
        setActiveKey(null);
        setScrollTop(0);
      });
    return () => {
      alive = false;
    };
  }, [source, props.revision]);

  // Editor → tree (#890): when the caret (or the tree) changes, highlight the deepest node whose OWN span
  // contains the caret and expand its ancestors so it's visible. A missing caret (no source) leaves any
  // click-driven highlight alone; an out-of-range caret clears the highlight (nothing contains it).
  // Deps are the whole `caret` object (not its fields) so exhaustive-deps stays satisfied: the store hands
  // a fresh `{line,column}` object only when the caret actually moves (setCursor), and a stable reference
  // otherwise — so this re-runs on a real caret move, not on the panel's own state re-renders.
  useEffect(() => {
    if (!caret || tree == null) return;
    const hit = deepestContaining(tree, caret.line, caret.column);
    setActiveKey(hit?.key ?? null);
    if (hit) setExpanded((prev) => withAncestorsExpanded(prev, hit.key));
  }, [caret, tree]);

  // Bring the row at `index` into the mounted window by adjusting the scroll offset — both the `scrollTop`
  // state (drives which rows render) and the real container (so the browser scrollbar tracks it). Because
  // each row sits at content-y `index * rowHeight`, the offset maps directly. A no-op when it's in view.
  const scrollIndexIntoView = (index: number): void => {
    // Account for the sticky band (#1106) the same way windowRange does, so "is this row visible?" agrees.
    const viewport = Math.max(rowHeight, (viewportH || rowHeight * FALLBACK_VIEWPORT_ROWS) - bandHeight);
    const rowTop = index * rowHeight;
    const rowBottom = rowTop + rowHeight;
    let next = scrollTop;
    if (rowTop < scrollTop) next = rowTop;
    else if (rowBottom > scrollTop + viewport) next = rowBottom - viewport;
    if (next !== scrollTop) {
      setScrollTop(next);
      if (treeRef.current) treeRef.current.scrollTop = next;
    }
  };

  // Editor → tree scroll (#890/#1098): once the highlighted row (and its just-expanded ancestors) settle,
  // bring it into view. In a windowed tree the target may not be mounted, so scroll by INDEX to pull it
  // into the window (which also scrolls the container to reveal it); otherwise scroll the element itself
  // into view (guarded — happy-dom / older engines may not implement it). Keyed on `activeKey` so only a
  // NEW caret target scrolls — re-running on the user's own scroll (`scrollTop`) or an unrelated expand
  // (`expanded`) would fight them, so those (and `rows`) are read as their latest value here, not triggers.
  useEffect(() => {
    if (activeKey == null) return;
    const index = rows.findIndex((r) => r.key === activeKey);
    if (index === -1) return;
    if (rows.length > VIRTUALIZE_THRESHOLD) scrollIndexIntoView(index);
    else treeRef.current?.querySelector<HTMLElement>(`[data-key="${activeKey}"]`)?.scrollIntoView?.({ block: 'nearest' });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire only on a new caret target (see comment)
  }, [activeKey]);

  // Focus a row that a windowed jump just scrolled into view — its DOM node didn't exist when the key was
  // pressed. Runs after the scroll-driven re-render mounts it; a no-op for the common in-window case, which
  // `focusRow` focuses synchronously. Shared by keyboard nav and the refetch refocus below.
  useEffect(() => {
    if (pendingKey == null) return;
    // `:not([data-band])` so focus lands on the REAL window row, not the sticky-band copy that may share this
    // `data-key` (#1106).
    treeRef.current?.querySelector<HTMLElement>(`[data-key="${pendingKey}"]:not([data-band])`)?.focus();
    setPendingKey(null);
  }, [pendingKey]);

  // Re-home keyboard focus onto the restored row after a refetch commit (#1097), but only when the fetch
  // resolve flagged it (focus was in the tree AND a row was restored). Fires exactly once per such refetch
  // via the `refocusTick` bump; a no-op on mount and on refetches with nothing to restore. In a windowed
  // tree (#1098) the restored row may be outside the mounted slice (the refetch reset the scroll to the
  // top), so scroll it into the window and let the pending-focus effect focus it once it mounts; otherwise
  // focus it directly (guarded — happy-dom / older engines may not implement `focus` on a plain element).
  useEffect(() => {
    const key = refocusKeyRef.current;
    refocusKeyRef.current = null;
    if (key == null) return;
    const index = rows.findIndex((r) => r.key === key);
    if (index !== -1 && rows.length > VIRTUALIZE_THRESHOLD) {
      scrollIndexIntoView(index);
      setPendingKey(key);
    } else {
      treeRef.current?.querySelector<HTMLElement>(`[data-key="${key}"]:not([data-band])`)?.focus?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire once per refocus request (see comment)
  }, [refocusTick]);

  // Measure the scroll viewport AND the real row height (#1098) so the window mounts exactly the rows it
  // needs and its padding lines up with the actual (font-scaled) row height — not a hard-coded pixel guess.
  // A ResizeObserver tracks the container itself (the right-rail splitter resizes it WITHOUT a window
  // resize event); the window listener covers font/zoom changes. happy-dom / a pre-layout paint report 0 —
  // the render then falls back to ROW_HEIGHT and a fixed-size window.
  useEffect(() => {
    const el = treeRef.current;
    if (!el) return;
    const measure = (): void => {
      setViewportH(el.clientHeight);
      const rowEl = el.querySelector<HTMLElement>('.koi-stree-item');
      if (rowEl && rowEl.offsetHeight > 0) setRowHeight(rowEl.offsetHeight);
    };
    measure();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    window.addEventListener('resize', measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [tree]);

  // Measure the sticky ancestors band's pixel height (#1106) whenever its content changes, so windowRange can
  // subtract it and keep the window bounded. happy-dom / a pre-layout paint report 0 (no layout) → the band
  // never perturbs the window count under test; a real browser reports its true height. The functional update
  // bails on an unchanged value, so a stable band can't drive a measure→re-render→measure feedback loop.
  useEffect(() => {
    const h = bandRef.current?.offsetHeight ?? 0;
    setBandHeight((prev) => (prev === h ? prev : h));
  }, [ancestorPath, rowHeight, tree]);

  /** Move roving focus to the row at `index` in the flattened `navRows`, making it the lone tab stop. An
   *  in-window row focuses immediately; an off-window row is scrolled into the window and focused once it
   *  mounts (the pending-focus effect) — so keyboard nav reaches every row, not just the mounted slice. */
  function focusRow(navRows: Row[], index: number): void {
    if (index < 0 || index >= navRows.length) return;
    const key = navRows[index].key;
    setFocusedKey(key);
    const win = windowRange(navRows.length, scrollTop, viewportH, rowHeight, bandHeight);
    const mounted = navRows.length <= VIRTUALIZE_THRESHOLD || (index >= win.first && index < win.last);
    if (mounted) {
      // `:not([data-band])` targets the real window row, never a sticky-band copy sharing its key (#1106).
      treeRef.current?.querySelector<HTMLElement>(`[data-key="${key}"]:not([data-band])`)?.focus();
    } else {
      scrollIndexIntoView(index);
      setPendingKey(key);
    }
  }

  const toggle = (key: string): void =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  // The WAI-ARIA tree keyboard model, delegated on the root: ArrowUp/Down across the flattened visible
  // rows, Home/End to the ends, ArrowRight to expand / descend, ArrowLeft to collapse / ascend. Enter/Space
  // SELECT the row and jump the editor to its span (mirroring a row click) — expand/collapse is Arrow-only,
  // so keyboard users reach the tree → source navigation a mouse click gives (WCAG 2.1.1). Nav indexes into
  // `flattenVisible` (not the DOM), so it reaches rows the virtualization has scrolled out of the window.
  function onKeyDown(ev: JSX.TargetedKeyboardEvent<HTMLDivElement>): void {
    if (tree == null) return;
    const navRows = rows;
    if (!navRows.length) return;
    const current = (ev.target as HTMLElement | null)?.closest<HTMLElement>('[role="treeitem"]') ?? null;
    const key = current?.dataset.key ?? focusedKey ?? ROOT_KEY;
    const idx = navRows.findIndex((r) => r.key === key);
    if (idx === -1) return;
    const { node, hasChildren, isExpanded } = navRows[idx];

    switch (ev.key) {
      case 'ArrowDown':
        ev.preventDefault();
        focusRow(navRows, Math.min(navRows.length - 1, idx + 1));
        break;
      case 'ArrowUp':
        ev.preventDefault();
        focusRow(navRows, Math.max(0, idx - 1));
        break;
      case 'Home':
        ev.preventDefault();
        focusRow(navRows, 0);
        break;
      case 'End':
        ev.preventDefault();
        focusRow(navRows, navRows.length - 1);
        break;
      case 'ArrowRight':
        if (hasChildren) {
          ev.preventDefault();
          if (!isExpanded) {
            toggle(key); // expand in place; focus stays on this row (its DOM node persists)
            setFocusedKey(key);
          } else {
            focusRow(navRows, idx + 1); // already open → step into the first child (next visible row)
          }
        }
        break;
      case 'ArrowLeft':
        ev.preventDefault();
        if (hasChildren && isExpanded) {
          toggle(key); // collapse in place; focus stays on this (still-visible) row
          setFocusedKey(key);
        } else if (key.includes('/')) {
          const parentKey = key.slice(0, key.lastIndexOf('/'));
          const parentIdx = navRows.findIndex((r) => r.key === parentKey);
          if (parentIdx !== -1) focusRow(navRows, parentIdx);
        }
        break;
      case 'Enter':
      case ' ':
        ev.preventDefault();
        setFocusedKey(key);
        setActiveKey(key);
        onNodeClick?.(node); // select + jump to source, exactly as a row click does
        break;
    }
  }

  // --- empty / loading states (after the hooks, so the hook order is stable) ---
  if (tree === undefined) {
    return (
      <div class="koi-stree koi-stree-empty">
        <p class="koi-docs-empty">Parsing…</p>
      </div>
    );
  }
  if (tree === null || tree.children.length === 0) {
    return (
      <div class="koi-stree koi-stree-empty">
        <div class="koi-rview-empty">
          <h3 class="koi-rview-empty-title">Syntax tree</h3>
          <p class="muted">No syntax tree — start typing.</p>
        </div>
      </div>
    );
  }

  // One flat `role="treeitem"` row (no nested `role="group"` — hierarchy is carried by `aria-level`/
  // `aria-setsize`/`aria-posinset` so the list can be windowed). The treeitem is the focusable unit; the
  // twisty, recovery badges and leaf preview are decorative (aria-hidden) — the isolated `aria-label`
  // carries the spoken name. Clicking the row SELECTS it (highlights + fires `onNodeClick` → jump-to-span)
  // and takes the roving tab stop; the twisty is the separate expand/collapse affordance (keyboard still
  // toggles via Arrow/Enter/Space on the row). The caret-tracked or clicked node wears `--current`.
  function renderRow(row: Row, band = false): JSX.Element {
    const { key, node, level, setSize, posInSet, hasChildren, isExpanded } = row;
    // A band ancestor row (#1106) is context only: never the roving tab stop (that stays a single WINDOW
    // row), so it can't become a duplicate/second tab stop for AT or keyboard users.
    const tabbable = !band && key === (focusedKey ?? ROOT_KEY);
    const isCurrent = key === activeKey;
    const cls = ['koi-stree-item'];
    if (band) cls.push('koi-stree-item--band');
    if (node.isError) cls.push('koi-stree-item--error');
    if (node.isMissing) cls.push('koi-stree-item--missing');
    if (isCurrent) cls.push('koi-stree-item--current');
    const leafPreview = !hasChildren && node.leaf ? previewLeaf(node.leaf) : null;

    return (
      <div
        // Keyed by the stable index-path so the sliding window reconciles rows by IDENTITY, not DOM
        // position — otherwise a scroll would rewrite an in-place node's content while browser focus and
        // the roving tabindex stayed pinned to that physical node, desyncing focus from the row (#1098).
        key={key}
        role="treeitem"
        class={cls.join(' ')}
        data-key={key}
        // Marks the sticky-band copy of an ancestor (#1106) so the focus effects target the REAL window row,
        // never the band row that shares its `data-key`.
        data-band={band ? 'true' : undefined}
        aria-level={level}
        aria-setsize={setSize}
        aria-posinset={posInSet}
        aria-expanded={hasChildren ? isExpanded : undefined}
        aria-current={isCurrent ? 'true' : undefined}
        aria-label={accessibleName(node)}
        tabIndex={tabbable ? 0 : -1}
        onClick={
          band
            ? (e) => {
                // Activating a band ancestor is NAVIGATION, not selection: scroll its real row back into the
                // window and move the single roving tab stop onto it (reusing the deferred focusRow path) —
                // never a duplicate tab stop, and it doesn't fire onNodeClick/jump-to-source (#1106).
                e.stopPropagation();
                focusRow(rows, rows.findIndex((r) => r.key === key));
              }
            : (e) => {
                e.stopPropagation();
                setFocusedKey(key);
                setActiveKey(key);
                onNodeClick?.(node);
              }
        }
      >
        <div class="koi-stree-row" style={{ paddingInlineStart: `${(level - 1) * 0.85 + 0.2}rem` }}>
          <span
            class={`koi-stree-twisty${hasChildren ? '' : ' koi-stree-twisty--leaf'}`}
            aria-hidden="true"
            onClick={
              hasChildren && !band
                ? (e) => {
                    // The twisty is the expand/collapse affordance: toggle in place WITHOUT selecting the
                    // row (stopPropagation keeps the treeitem's select+navigate handler from also firing).
                    e.stopPropagation();
                    toggle(key);
                    setFocusedKey(key);
                  }
                : undefined // a band ancestor's twisty is inert — collapsing it from the frozen band would
              // rip its own subtree (the window) out from under the user; activate the row to navigate instead
            }
          >
            {hasChildren ? (isExpanded ? '▾' : '▸') : ''}
          </span>
          <span class="koi-stree-kind">{node.kind}</span>
          {node.name != null && <span class="koi-stree-name">{node.name}</span>}
          {node.isError && (
            <span class="koi-stree-badge koi-stree-badge--error" aria-hidden="true">
              error
            </span>
          )}
          {node.isMissing && (
            <span class="koi-stree-badge koi-stree-badge--missing" aria-hidden="true">
              missing
            </span>
          )}
          {leafPreview && (
            <span class="koi-stree-leaf" aria-hidden="true">
              {leafPreview}
            </span>
          )}
        </div>
      </div>
    );
  }

  // Mount only the viewport window of the (memoised) visible rows (#1098). A small tree (≤ threshold)
  // renders every row in normal flow — the pre-virtualization behaviour; a large one mounts just the
  // slice, offset by top/bottom padding that stands in for the rest so the region scrolls as if all rows
  // were present.
  const total = rows.length;
  const windowRows = rows.slice(first, last);

  // Two elements on purpose (#1098): the OUTER `.koi-stree-scroll` is the bounded scroll viewport
  // (`treeRef` — its `clientHeight`/`scrollTop` drive the window); the INNER `role="tree"` carries the
  // windowing padding + the mounted rows. Keeping the padding OFF the scroller is what stops the padding
  // from inflating the scroller's measured height into a resize feedback loop. The sticky ancestors band
  // (#1106) is the first child of the tree — a `position:sticky` block of the window-top row's ancestors so
  // the aria-level chain stays unbroken in the DOM; the leading padding is reduced by its height so the total
  // scroll height stays exact.
  return (
    <div class="koi-stree">
      <div
        ref={treeRef}
        class="koi-stree-scroll"
        onScroll={virtualize ? (e) => setScrollTop(e.currentTarget.scrollTop) : undefined}
      >
        <div
          role="tree"
          aria-label="Syntax tree"
          onKeyDown={onKeyDown}
          style={
            virtualize
              ? {
                  paddingTop: `${Math.max(0, first * rowHeight - bandHeight)}px`,
                  paddingBottom: `${(total - last) * rowHeight}px`,
                }
              : undefined
          }
        >
          {ancestorPath.length > 0 && (
            <div class="koi-stree-band" ref={bandRef}>
              {ancestorPath.map((row) => renderRow(row, true))}
            </div>
          )}
          {windowRows.map((row) => renderRow(row))}
        </div>
      </div>
    </div>
  );
}
