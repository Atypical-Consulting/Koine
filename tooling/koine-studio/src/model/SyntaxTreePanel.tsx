import { useEffect, useRef, useState } from 'preact/hooks';
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
interface Row {
  key: string;
  node: SyntaxTreeNode;
  level: number;
  setSize: number;
  posInSet: number;
  hasChildren: boolean;
  isExpanded: boolean;
}

/** The fixed row height (px) the window math assumes — mirrors `--koi-stree-row-h` in _syntax-tree.scss. */
const ROW_HEIGHT = 24;
/** At/below this many visible rows, render every row (windowing is pure overhead for a small tree). */
const VIRTUALIZE_THRESHOLD = 100;
/** Rows rendered above/below the viewport so a fast scroll doesn't flash blank. */
const OVERSCAN = 8;
/** Window size (in rows) when the container height can't be measured yet (pre-layout / happy-dom tests). */
const FALLBACK_VIEWPORT_ROWS = 40;

/** Pre-order flatten of the visible (expanded) rows. A collapsed node contributes its own row but none of
 *  its descendants — exactly the set the panel renders and the arrow keys traverse. */
function flattenVisible(root: SyntaxTreeNode, expanded: Set<string>): Row[] {
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
  // Windowing state (#1098): the live scroll offset and measured viewport height drive which slice of the
  // flattened rows is mounted. Both stay 0 for a small (unwindowed) tree, and 0 under happy-dom (no
  // layout), where the render falls back to a fixed-size window.
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(0);
  const treeRef = useRef<HTMLDivElement>(null);

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
        setTree(t ?? null);
        setExpanded(t ? defaultExpanded(t) : new Set());
        setFocusedKey(null); // reset the roving tab stop to the (new) root
        setActiveKey(null); // drop any stale highlight; the caret effect re-derives it for the new tree
      })
      .catch(() => {
        if (!alive) return;
        setTree(null);
        setExpanded(new Set());
        setFocusedKey(null);
        setActiveKey(null);
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

  // Scroll the highlighted row into view once it (and its just-expanded ancestors) are in the DOM. Keyed
  // on `activeKey` so a caret move that lands on the same node doesn't re-scroll; `scrollIntoView` is
  // guarded (happy-dom / older engines may not implement it).
  useEffect(() => {
    if (activeKey == null) return;
    const el = treeRef.current?.querySelector<HTMLElement>(`[data-key="${activeKey}"]`);
    el?.scrollIntoView?.({ block: 'nearest' });
  }, [activeKey]);

  // Measure the scroll viewport (#1098) so a windowed tree mounts exactly the rows it needs. happy-dom
  // and a pre-layout first paint report 0 height — the render then falls back to a fixed-size window.
  // Re-measured on window resize; re-runs when the tree changes (a new document can change the rail size).
  useEffect(() => {
    const measure = (): void => setViewportH(treeRef.current?.clientHeight ?? 0);
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [tree]);

  /** The visible treeitems in DOM (== visual) order — collapsed subtrees aren't in the DOM, so this is
   *  exactly the set Arrow keys traverse. Mirrors the domain navigator's `treeItems()`. */
  function visibleItems(): HTMLElement[] {
    const el = treeRef.current;
    return el ? Array.from(el.querySelectorAll<HTMLElement>('[role="treeitem"]')) : [];
  }

  /** Move roving focus to a visible row (already in the DOM): focus it, then make it the lone tab stop. */
  function moveFocus(el: HTMLElement | undefined): void {
    if (!el) return;
    el.focus();
    setFocusedKey(el.dataset.key ?? null);
  }

  const toggle = (key: string): void =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  // The WAI-ARIA tree keyboard model, delegated on the root: ArrowUp/Down across visible rows, Home/End
  // to the ends, ArrowRight to expand / descend, ArrowLeft to collapse / ascend. Enter/Space SELECT the
  // row and jump the editor to its span (mirroring a row click) — expand/collapse is Arrow-only, so
  // keyboard users reach the tree → source navigation that a mouse click gives (WCAG 2.1.1).
  function onKeyDown(ev: JSX.TargetedKeyboardEvent<HTMLDivElement>): void {
    const items = visibleItems();
    if (!items.length || tree == null) return;
    const current = (ev.target as HTMLElement | null)?.closest<HTMLElement>('[role="treeitem"]') ?? null;
    const idx = current ? items.indexOf(current) : -1;
    const key = current?.dataset.key ?? null;
    const node = key ? nodeAtKey(tree, key) : null;
    const hasChildren = !!node && node.children.length > 0;
    const isExpanded = !!key && expanded.has(key);

    switch (ev.key) {
      case 'ArrowDown':
        ev.preventDefault();
        moveFocus(items[Math.min(items.length - 1, idx + 1)] ?? items[0]);
        break;
      case 'ArrowUp':
        ev.preventDefault();
        moveFocus(items[Math.max(0, idx - 1)] ?? items[0]);
        break;
      case 'Home':
        ev.preventDefault();
        moveFocus(items[0]);
        break;
      case 'End':
        ev.preventDefault();
        moveFocus(items[items.length - 1]);
        break;
      case 'ArrowRight':
        if (hasChildren && key) {
          ev.preventDefault();
          if (!isExpanded) toggle(key); // expand in place; focus stays on this row (its DOM node persists)
          else moveFocus(items[idx + 1]); // already open → step into the first child (next visible row)
        }
        break;
      case 'ArrowLeft':
        if (key) {
          ev.preventDefault();
          if (hasChildren && isExpanded) {
            toggle(key); // collapse in place; focus stays on this (still-visible) row
            setFocusedKey(key);
          } else if (key.includes('/')) {
            moveFocus(items.find((el) => el.dataset.key === key.slice(0, key.lastIndexOf('/'))));
          }
        }
        break;
      case 'Enter':
      case ' ':
        if (key && node) {
          ev.preventDefault();
          setFocusedKey(key);
          setActiveKey(key);
          onNodeClick?.(node); // select + jump to source, exactly as a row click does
        }
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
  function renderRow(row: Row): JSX.Element {
    const { key, node, level, setSize, posInSet, hasChildren, isExpanded } = row;
    const tabbable = key === (focusedKey ?? ROOT_KEY);
    const isCurrent = key === activeKey;
    const cls = ['koi-stree-item'];
    if (node.isError) cls.push('koi-stree-item--error');
    if (node.isMissing) cls.push('koi-stree-item--missing');
    if (isCurrent) cls.push('koi-stree-item--current');
    const leafPreview = !hasChildren && node.leaf ? previewLeaf(node.leaf) : null;

    return (
      <div
        role="treeitem"
        class={cls.join(' ')}
        data-key={key}
        aria-level={level}
        aria-setsize={setSize}
        aria-posinset={posInSet}
        aria-expanded={hasChildren ? isExpanded : undefined}
        aria-current={isCurrent ? 'true' : undefined}
        aria-label={accessibleName(node)}
        tabIndex={tabbable ? 0 : -1}
        onClick={(e) => {
          e.stopPropagation();
          setFocusedKey(key);
          setActiveKey(key);
          onNodeClick?.(node);
        }}
      >
        <div class="koi-stree-row" style={{ paddingInlineStart: `${(level - 1) * 0.85 + 0.2}rem` }}>
          <span
            class={`koi-stree-twisty${hasChildren ? '' : ' koi-stree-twisty--leaf'}`}
            aria-hidden="true"
            onClick={
              hasChildren
                ? (e) => {
                    // The twisty is the expand/collapse affordance: toggle in place WITHOUT selecting the
                    // row (stopPropagation keeps the treeitem's select+navigate handler from also firing).
                    e.stopPropagation();
                    toggle(key);
                    setFocusedKey(key);
                  }
                : undefined
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

  // Flatten to the ordered visible rows, then mount only the viewport window (#1098). A small tree
  // (≤ threshold) renders every row in normal flow — byte-for-byte the pre-virtualization behaviour;
  // a large one mounts just the slice, offset by top/bottom padding that stands in for the rest so the
  // region scrolls as if all rows were present.
  const rows = flattenVisible(tree, expanded);
  const total = rows.length;
  const virtualize = total > VIRTUALIZE_THRESHOLD;

  let first = 0;
  let last = total;
  if (virtualize) {
    const viewport = viewportH || ROW_HEIGHT * FALLBACK_VIEWPORT_ROWS;
    first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
    last = Math.min(total, first + Math.ceil(viewport / ROW_HEIGHT) + OVERSCAN * 2);
  }
  const windowRows = rows.slice(first, last);

  return (
    <div class="koi-stree">
      <div
        ref={treeRef}
        class={`koi-stree-scroll${virtualize ? ' koi-stree-scroll--virtual' : ''}`}
        role="tree"
        aria-label="Syntax tree"
        onKeyDown={onKeyDown}
        onScroll={virtualize ? (e) => setScrollTop(e.currentTarget.scrollTop) : undefined}
        style={virtualize ? { paddingTop: `${first * ROW_HEIGHT}px`, paddingBottom: `${(total - last) * ROW_HEIGHT}px` } : undefined}
      >
        {windowRows.map((row) => renderRow(row))}
      </div>
    </div>
  );
}
