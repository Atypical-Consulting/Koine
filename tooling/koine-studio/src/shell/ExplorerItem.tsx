import { useEffect, useRef } from 'preact/hooks';
import type { ComponentChildren, JSX } from 'preact';
import type { FsEntry } from '@/host';
import { koiStem } from '@/shell/explorerModel';

// One workspace-explorer row (#989 task 2, corrected in the task-2a follow-up): a keyed
// `<li role="treeitem">` — the Preact counterpart of explorer.ts's `buildItem()`. Ported for
// STATIC-render parity: the icon classifier, dirty dot, error/warning badge, active row
// (aria-current/aria-selected) and filter-match highlight all mirror buildItem() exactly. The "…"
// context-menu trigger is NOT here (right-click + the ContextMenu key cover it, see `ExplorerPanel`); a
// directory click (this component's only click affordance today) simply toggles expansion via
// `onToggle`, and a file click opens it via `onOpen`. As of task 3, `tabIndex` is a pure function of the `focused` prop
// (`ExplorerPanel`'s roving-tabindex state) rather than a fixed -1 — see `focused` below. The actual
// keydown ROUTING (ArrowUp/Down/Left/Right, Enter, F2/Delete/ContextMenu) lives entirely in
// `ExplorerPanel`'s single delegated `onKeyDown` on `ul[role="tree"]`, not here — this component owns no
// keyboard handling of its own. As of task 4, right-click DOES get a per-row listener here (`onContextMenu`,
// wired straight to `.explorer-row`) rather than a delegated one: unlike a nested `<li role="treeitem">`,
// `.explorer-row` elements are never nested inside one another (a directory's children live in a sibling
// `.explorer-children` list, not inside its own `.explorer-row`), so there is no ancestor-bubbling
// double-fire risk to design around here — `ExplorerPanel` still owns a SEPARATE delegated `contextmenu`
// listener on the tree itself, purely to catch a right-click on empty background (see its `onTreeContextMenu`).
//
// INLINE RENAME (#989 task 5): when `ExplorerPanel` is renaming THIS row (its `editing` state's token
// matches), it hands down a `renaming` prop bundling the controlled input's value/invalid flag/handlers —
// `.explorer-name` is swapped for a controlled `<input class="explorer-rename">` (ported from explorer.ts's
// `startRename`'s DOM-mutation technique, but as a plain conditional render: the surrounding `<li>` keeps
// its own Preact identity via `key={token}` in `ExplorerPanel`, so nothing here needs to detach/reattach
// anything). Focus + the stem preselection (`setSelectionRange`) are the one bit of imperative DOM work
// Preact can't express declaratively, so they're a `useEffect` gated on `renaming` FLIPPING to defined
// (not on every keystroke — see the effect below).
//
// DRAG-AND-DROP MOVE (#989 task 6): `.explorer-row` is unconditionally `draggable` and wired for every
// native drag event; `ExplorerPanel` owns all drop-validity/ancestry logic (`parentMapOf`-based, not a
// DOM walk) and only hands this component plain forwarding callbacks plus two booleans — `dragging`
// (adds `.is-dragging` to this row's own `<li>`) and `dropTarget` (adds `.is-drop-target` to
// `.explorer-row`) — ported verbatim from explorer.ts's `wireDrag`/`markDropTarget` class names
// (`_explorer.scss` styles them). `ExplorerPanel`'s own `onDragStart` handler checks its `editing` state
// (mirroring explorer.ts's `row.querySelector('.explorer-rename')` guard) so a text-selection drag inside
// a mid-rename/mid-create input can never be mistaken for a row-move drag — that check happens one layer
// up, not in this component.
//
// RECURSIVE NESTING (the task-2a fix): a directory's rendered children are passed in as `children` —
// already-built `<ExplorerItem>` elements for its immediate entries, recursively built the same way one
// level up — and this component wraps them in a nested `<ul class="explorer-children" role="group">`
// that is a DIRECT CHILD of this row's own `<li>`, exactly matching explorer.ts's `buildItem()` nesting
// (and the `.explorer-tree li[aria-expanded='false'] > .explorer-children` CSS collapse selector, which
// only works with this literal nesting). The caller (`ExplorerPanel`) only supplies `children` for an
// EXPANDED directory — a collapsed directory simply isn't given any, so nothing is rendered for it (the
// JS/Preact equivalent of the original's CSS `display:none`); `expanded` still reflects true state via
// `aria-expanded` regardless, so a later re-expand (or a test toggling it) works correctly.
//
// This component owns nothing but its own row-shaped props (and its already-rendered child rows) — no
// `collapsed`/`filterText` state, no ExplorerCallbacks — so `ExplorerPanel` (which walks the entry tree
// via `explorerModel.ts`'s `analyze()` for filter-visibility and derives `expanded`/`active`/`dirty`/
// diagnostics from `ExplorerCallbacks` per entry) is the sole owner of that lifecycle. Being its own
// component (not just a rendering function) makes each row's Preact identity explicit, which is what the
// "keyed identity" test in ExplorerPanel.test.tsx pins: an untouched row keeps its DOM node across a
// re-render that only changes a SIBLING row's props.
export interface ExplorerItemProps {
  token: string;
  kind: FsEntry['kind'];
  name: string;
  /** 1-based ARIA tree level — matches explorer.ts's `aria-level`. */
  level: number;
  /** Directories only — whether this row's children are shown. */
  expanded: boolean;
  /** Files only — whether this is the open/active buffer. */
  active: boolean;
  /** Files only — an unsaved-changes dot. */
  dirty: boolean;
  errors: number;
  warnings: number;
  /** The active (lowercased, trimmed) filter query, for the `<mark>` highlight — '' when not filtering. */
  filterText: string;
  /** Directories only — toggle expand/collapse. */
  onToggle: () => void;
  /** Files only — open the buffer. */
  onOpen: () => void;
  /**
   * Right-click anywhere in this row (name, icon, twisty) — opens the SAME row action menu the
   * `ContextMenu` key opens (#989 task 4). `ExplorerPanel` owns the actual menu; this only forwards the
   * native event so it can call `preventDefault()` and read the click coordinates.
   */
  onContextMenu: (ev: JSX.TargetedMouseEvent<HTMLDivElement>) => void;
  /**
   * Directories only — this directory's already-rendered child rows (recursive `ExplorerItem`s), or
   * `undefined` when collapsed / not a directory. When provided (even an empty array, for an expanded-but-
   * empty directory), wrapped in a nested `<ul class="explorer-children" role="group">`.
   */
  children?: ComponentChildren;
  /**
   * Whether this row is the lone WAI-ARIA roving tab stop (#989 task 3) — `ExplorerPanel` derives this
   * from its `focusedToken` state (one row `true` at a time), so `tabIndex` is a pure function of that
   * state rather than an imperative `querySelectorAll` sweep. Defaults to `false` (not the tab stop).
   */
  focused?: boolean;
  /**
   * Present iff `ExplorerPanel`'s `editing` state is a rename targeting THIS row's token (#989 task 5) —
   * bundles the controlled `<input class="explorer-rename">`'s value/invalid flag and its
   * input/keydown/blur handlers (all owned by `ExplorerPanel`, which alone knows the shared inline-edit
   * commit/cancel lifecycle create-row and rename-row share). `undefined` (the default) renders the
   * plain `.explorer-name` label.
   */
  renaming?: ExplorerItemRenamingProps;
  /**
   * Whether this row is the in-flight drag source (#989 task 6) — adds `.is-dragging` to this row's own
   * `<li>` (ported from explorer.ts's `wireDrag`'s `li.classList.add('is-dragging')`). Defaults to `false`.
   */
  dragging?: boolean;
  /**
   * Whether this row is the current drop-target destination (#989 task 6) — adds `.is-drop-target` to
   * `.explorer-row` (ported from explorer.ts's `markDropTarget`). Defaults to `false`.
   */
  dropTarget?: boolean;
  /**
   * ADR-0009 (#1188) active-context scope emphasis — files only, `undefined` for a neutral row
   * (directories, non-`.koi` files, or no active scope). `'is-scoped'` marks the `.koi` file whose
   * stem names the active bounded context; `'dim'` de-emphasises every OTHER context's `.koi` file.
   * `ExplorerPanel` alone computes which (if either) applies — including the "never dim the active/
   * open file" and "a scope naming no present file is a no-op" rules — this component only adds the
   * given class to `.explorer-row` (ported from explorer.ts's `buildItem`'s
   * `row.classList.add('is-scoped' | 'dim')`).
   */
  scopeClass?: 'is-scoped' | 'dim';
  /**
   * Whether this row is the target of the most recent "Reveal in Files" request (#453, #989 task 8) —
   * adds `.is-revealed` to `.explorer-row` (ported from explorer.ts's `revealByContext`'s
   * `row.classList.add('is-revealed')`). `ExplorerPanel` alone tracks which (at most one) row this is;
   * this component only adds the class. Defaults to `false`.
   */
  revealed?: boolean;
  /**
   * Native drag events forwarded straight through to `.explorer-row` — `ExplorerPanel` alone owns
   * drop-validity/ancestry (`parentMapOf`) and the in-flight `drag`/`dropMark` state (#989 task 6); this
   * component has no drag logic of its own beyond making the row draggable and calling these back.
   */
  onDragStart: (ev: JSX.TargetedDragEvent<HTMLDivElement>) => void;
  onDragEnd: (ev: JSX.TargetedDragEvent<HTMLDivElement>) => void;
  onDragOver: (ev: JSX.TargetedDragEvent<HTMLDivElement>) => void;
  onDragLeave: (ev: JSX.TargetedDragEvent<HTMLDivElement>) => void;
  onDrop: (ev: JSX.TargetedDragEvent<HTMLDivElement>) => void;
}

/** See {@link ExplorerItemProps.renaming}. */
export interface ExplorerItemRenamingProps {
  value: string;
  invalid: boolean;
  onInput: (ev: JSX.TargetedEvent<HTMLInputElement>) => void;
  onKeyDown: (ev: JSX.TargetedKeyboardEvent<HTMLInputElement>) => void;
  onBlur: (ev: JSX.TargetedFocusEvent<HTMLInputElement>) => void;
}

/**
 * Ported from explorer.ts's `markInvalid()` — the shared invalid-name tooltip text. Exported so
 * `ExplorerPanel`'s create-row (which renders its own `<input>` inline, outside this component) uses the
 * IDENTICAL string rather than a second copy that could drift.
 */
export const INVALID_NAME_TITLE = 'A name can’t contain “/”, “\\”, “.” or “..”.';

export function ExplorerItem(props: ExplorerItemProps): JSX.Element {
  const {
    token,
    kind,
    name,
    level,
    expanded,
    active,
    dirty,
    errors,
    warnings,
    filterText,
    onToggle,
    onOpen,
    onContextMenu,
    children,
    focused,
    renaming,
    dragging,
    dropTarget,
    scopeClass,
    revealed,
    onDragStart,
    onDragEnd,
    onDragOver,
    onDragLeave,
    onDrop,
  } = props;
  const isDir = kind === 'dir';
  const isActiveFile = !isDir && active;
  const hasBadge = !isDir && (errors > 0 || warnings > 0);
  const isRenaming = renaming !== undefined;

  // Focus the rename input and preselect the stem, once, right when renaming STARTS — not on every
  // keystroke. `isRenaming` (a plain boolean) is the dependency rather than `renaming` itself: a fresh
  // `renaming` object literal arrives from `ExplorerPanel` on every keystroke (its `value` changes), so
  // depending on the object would re-focus/re-select on every character typed, blowing away the user's
  // own cursor position. Ported from explorer.ts's `startRename`'s `input.focus()` +
  // `input.setSelectionRange(0, dot > 0 ? dot : entry.name.length)`.
  const renameInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!isRenaming) return;
    const input = renameInputRef.current;
    if (!input) return;
    input.focus();
    const dot = kind === 'file' ? name.lastIndexOf('.') : -1;
    input.setSelectionRange(0, dot > 0 ? dot : name.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see the comment above: keyed on isRenaming only
  }, [isRenaming]);

  return (
    <li
      role="treeitem"
      data-kind={kind}
      data-token={token}
      aria-level={level}
      aria-expanded={isDir ? expanded : undefined}
      aria-selected={isActiveFile ? 'true' : undefined}
      tabIndex={focused ? 0 : -1}
      class={dragging ? 'is-dragging' : undefined}
    >
      <div
        class={rowClassName(dropTarget, scopeClass, revealed)}
        aria-current={isActiveFile ? 'true' : undefined}
        style={{ '--depth': String(level - 1) }}
        // Defense in depth (code-review fix): `ExplorerPanel`'s `onRowDragStart` already
        // `preventDefault()`s a drag start while THIS row is being renamed (an `editing`-state check), but
        // the old `explorer.ts` additionally flipped `row.draggable = false` at the DOM-attribute level for
        // the edit's whole duration — not relying solely on cancelling the event. Mirrors that here: a
        // renaming row's native text-drag (for cursor placement / text selection inside the input) should
        // never be shadowed by a stale `draggable` attribute on its ancestor row.
        draggable={!isRenaming}
        onClick={isDir ? onToggle : onOpen}
        onContextMenu={onContextMenu}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        <span
          class="explorer-twisty"
          aria-hidden="true"
          onClick={
            isDir
              ? (e: MouseEvent) => {
                  e.stopPropagation();
                  onToggle();
                }
              : undefined
          }
        >
          {isDir ? (expanded ? '▾' : '▸') : ''}
        </span>
        <ItemIcon kind={kind} name={name} expanded={expanded} />
        {renaming ? (
          <input
            ref={renameInputRef}
            type="text"
            class={renaming.invalid ? 'explorer-rename is-invalid' : 'explorer-rename'}
            id="koi-explorer-rename"
            name="koi-explorer-rename"
            aria-label={`Rename ${name}`}
            title={renaming.invalid ? INVALID_NAME_TITLE : undefined}
            spellcheck={false}
            value={renaming.value}
            onInput={renaming.onInput}
            onKeyDown={renaming.onKeyDown}
            onBlur={renaming.onBlur}
            // Renaming replaces the label, not the row: without this, a click to place the text cursor
            // bubbles to `.explorer-row`'s own onClick above and toggles/opens the row mid-edit.
            onClick={(e: MouseEvent) => e.stopPropagation()}
          />
        ) : (
          <span class="explorer-name">{highlightMatch(name, filterText)}</span>
        )}
        {!isDir && dirty && (
          <span class="tree-dirty" title="Unsaved changes">
            •
          </span>
        )}
        {hasBadge && (
          <span
            class={errors > 0 ? 'tree-badge tree-badge-err' : 'tree-badge tree-badge-warn'}
            title={`${errors} error(s), ${warnings} warning(s)`}
          >
            {errors > 0 ? errors : warnings}
          </span>
        )}
      </div>
      {isDir && expanded && children !== undefined && (
        <ul class="explorer-children" role="group">
          {children}
        </ul>
      )}
    </li>
  );
}

// `.explorer-row`'s class list: the base class plus whichever of `.is-drop-target` (#989 task 6) /
// `.is-scoped/.dim` (ADR-0009 scope emphasis) / `.is-revealed` (#989 task 8) apply — all independent
// (a row can in principle be a drop target AND scope-emphasised AND the reveal target) so they're
// combined rather than treated as exclusive.
function rowClassName(
  dropTarget: boolean | undefined,
  scopeClass: 'is-scoped' | 'dim' | undefined,
  revealed: boolean | undefined,
): string {
  let cls = 'explorer-row';
  if (dropTarget) cls += ' is-drop-target';
  if (scopeClass) cls += ` ${scopeClass}`;
  if (revealed) cls += ' is-revealed';
  return cls;
}

// Wrap the filter match in <mark>, mirroring explorer.ts's fillName() — the FIRST case-insensitive
// occurrence only (a name matches the filter at most meaningfully once for this highlight).
function highlightMatch(name: string, query: string): JSX.Element | string {
  if (!query) return name;
  const at = name.toLowerCase().indexOf(query);
  if (at < 0) return name;
  return (
    <>
      {name.slice(0, at)}
      <mark class="explorer-hl">{name.slice(at, at + query.length)}</mark>
      {name.slice(at + query.length)}
    </>
  );
}

// The type icon: brand diamond for `.koi` contexts, open/closed folder for dirs, neutral doc otherwise —
// ported verbatim (same classification + same SVG paths) from explorer.ts's classifyIcon()/ICON. Kept as
// literal JSX <svg> (not dangerouslySetInnerHTML'd markup strings) per the project's innerHTML ban
// (eslint.config.mjs's `no-restricted-syntax` gate — MdHtml.tsx is the only permitted innerHTML sink).
// Exported (#989 task 5) so `ExplorerPanel`'s inline-create row can reuse the exact same dir/koi glyph
// instead of a third, duplicated copy (explorer.ts's own `beginCreate` reuses its module-private `ICON`
// the same way).
export function ItemIcon({ kind, name, expanded }: { kind: FsEntry['kind']; name: string; expanded: boolean }): JSX.Element {
  if (kind === 'dir') {
    return (
      <span class="explorer-icon explorer-icon--dir" aria-hidden="true">
        {expanded ? <FolderOpenGlyph /> : <FolderGlyph />}
      </span>
    );
  }
  // Code-review fix: route through the SAME canonical `koiStem` the active-context scope emphasis and
  // "Reveal in Files" matching use, rather than a THIRD independent re-derivation of the `.koi`-suffix
  // test — one canonical rule, per the same reasoning `koiStem` was extracted from `explorer.ts` for.
  const isKoi = koiStem(name) !== null;
  return (
    <span class={`explorer-icon ${isKoi ? 'explorer-icon--koi' : 'explorer-icon--file'}`} aria-hidden="true">
      {isKoi ? <KoiGlyph /> : <FileGlyph />}
    </span>
  );
}

function KoiGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 1.4 14.6 8 8 14.6 1.4 8z" />
    </svg>
  );
}

function FolderGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M1.7 4.4c0-.6.5-1.1 1.1-1.1h3c.4 0 .7.2.9.5l.6.9h6c.6 0 1.1.5 1.1 1.1v6c0 .6-.5 1.1-1.1 1.1H2.8c-.6 0-1.1-.5-1.1-1.1z" />
    </svg>
  );
}

function FolderOpenGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M1.7 4.4c0-.6.5-1.1 1.1-1.1h3c.4 0 .7.2.9.5l.6.9h6c.6 0 1.1.5 1.1 1.1v1.1H4.5c-.5 0-1 .4-1.1.9L1.7 13z" />
      <path opacity=".5" d="M4.5 7.1h10.3c.5 0 .9.5.7 1l-1.2 4.3c-.1.5-.6.8-1.1.8H2.1c-.5 0-.9-.5-.7-1l1.2-4.3c.1-.5.6-.8 1.1-.8z" />
    </svg>
  );
}

function FileGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path fill="none" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round" d="M4 1.9h4.8L12 5.1v9H4z" />
    </svg>
  );
}
