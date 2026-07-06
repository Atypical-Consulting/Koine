// The WAI-ARIA roving-tabindex TREE keyboard model, extracted once and shared across every Studio tree
// panel (#1105). Three panels — the file explorer (`shell/explorer.ts`), the domain navigator
// (`model/domainNavigator.ts`) and the virtualized syntax-tree panel (`model/SyntaxTreePanel.tsx`) —
// had each hand-rolled the same ArrowUp/Down · Home/End · Enter/Space (· ArrowRight/Left) routing, so a
// fix to one never reached the others. This module owns the key routing exactly once; each panel keeps
// only the thin "where do the items come from / how do I focus one" glue behind {@link RovingTreeNav}.
//
// Framework-agnostic BY CONSTRUCTION: no `preact`, no `document`/`querySelector`. It never touches the
// DOM — it asks the host for the ordered items and delegates focusing back to the host, so it works
// whether the items are live DOM elements (explorer, domainNavigator) or a virtualized `Row[]` window
// (SyntaxTreePanel, which focuses an off-window row by scrolling it in first — #1098). Keep it that way.

/**
 * The item-source a tree panel exposes so {@link handleTreeKeydown} can route the WAI-ARIA tree keys
 * over it. `T` is whatever the host counts as a row (a DOM `<li>`, a flattened virtual `Row`, …) — the
 * router only ever indexes into `items()`, never inspects a `T`.
 */
export interface RovingTreeNav<T> {
  /** The ordered, currently-navigable items in visual order — the FULL logical set, including rows a
   *  virtualized panel has scrolled out of its render window (nav must reach them). */
  items(): readonly T[];
  /** Index of the item that currently holds the lone tab stop, or `-1` when none is active. */
  activeIndex(): number;
  /** Make item `i` the lone tab stop and focus it. The host decides how: `.focus()` a DOM node, or
   *  scroll a virtual row into the window and then focus it. `i` is always a valid index. */
  focusIndex(i: number): void;
  /** ArrowRight — expand-or-descend. Return `true` when the key was consumed (the router then calls
   *  `preventDefault`), `false` to leave it to the browser (e.g. a leaf with nothing to expand). Omit
   *  to opt the panel out of ArrowRight entirely. */
  expand?(i: number): boolean;
  /** ArrowLeft — collapse-or-ascend. Same `true`/`false` "consumed?" contract as {@link expand}. Omit
   *  to opt out of ArrowLeft. */
  collapse?(i: number): boolean;
  /** Enter (and Space, unless {@link supportsSpaceActivate} is `false`) — activate item `i`. Return
   *  `false` to leave the key to the browser (e.g. a row that is itself a `<button>` and activates
   *  natively); `true`/`void` marks it consumed → `preventDefault`. Omit to opt out of Enter/Space. */
  activate?(i: number): boolean | void;
  /** Whether `Home`/`End` jump to the first/last item. Defaults to `true` (the WAI-ARIA tree model);
   *  set `false` for a panel that never wired them and must not gain them (the file explorer). */
  supportsHomeEnd?: boolean;
  /** Whether `Space` activates like `Enter`. Defaults to `true`; set `false` where `Space` must keep
   *  its native behaviour and only `Enter` activates (the file explorer). */
  supportsSpaceActivate?: boolean;
}

/** Clamp `i` into `[0, length)`. */
function clamp(i: number, length: number): number {
  return Math.max(0, Math.min(length - 1, i));
}

/**
 * Route one keydown through the WAI-ARIA roving-tabindex tree model over `nav`:
 *
 * - `ArrowDown`/`ArrowUp` — move the tab stop to the next/previous item, clamped at the ends (NO wrap).
 * - `Home`/`End` — jump to the first/last item (unless `nav.supportsHomeEnd === false`).
 * - `ArrowRight`/`ArrowLeft` — delegate to `nav.expand`/`nav.collapse` when provided.
 * - `Enter`/`Space` — delegate to `nav.activate` (Space only when `nav.supportsSpaceActivate !== false`).
 *
 * `preventDefault()` is called ONLY for keys the router actually handles — a movement key always
 * prevents default; a structural/activation key prevents default only when its handler reports the key
 * consumed (returns anything but `false`). Every other key (Backspace, F2, typeahead, …) is left
 * untouched so the host can handle its own panel-specific keys around this call. An empty tree is a
 * no-op for every key.
 */
export function handleTreeKeydown<T>(nav: RovingTreeNav<T>, ev: KeyboardEvent): void {
  const items = nav.items();
  if (items.length === 0) return;
  const current = nav.activeIndex();

  switch (ev.key) {
    case 'ArrowDown':
      ev.preventDefault();
      nav.focusIndex(clamp(current + 1, items.length));
      break;
    case 'ArrowUp':
      ev.preventDefault();
      nav.focusIndex(clamp(current - 1, items.length));
      break;
    case 'Home':
      if (nav.supportsHomeEnd === false) break;
      ev.preventDefault();
      nav.focusIndex(0);
      break;
    case 'End':
      if (nav.supportsHomeEnd === false) break;
      ev.preventDefault();
      nav.focusIndex(items.length - 1);
      break;
    case 'ArrowRight':
      // Structural/activation keys need a real row to act on; with nothing active (`current < 0`) they
      // are no-ops, so an adapter whose expand/collapse/activate index into `items()[i]` never sees -1.
      if (current >= 0 && nav.expand?.(current)) ev.preventDefault();
      break;
    case 'ArrowLeft':
      if (current >= 0 && nav.collapse?.(current)) ev.preventDefault();
      break;
    case 'Enter':
    case ' ':
      if (ev.key === ' ' && nav.supportsSpaceActivate === false) break;
      if (current < 0 || !nav.activate) break;
      if (nav.activate(current) !== false) ev.preventDefault();
      break;
  }
}
