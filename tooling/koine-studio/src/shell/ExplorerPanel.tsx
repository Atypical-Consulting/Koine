import { useEffect, useMemo, useState } from 'preact/hooks';
import type { ComponentChildren, JSX } from 'preact';
import type { FsEntry } from '@/host';
import type { ExplorerCallbacks, ExplorerRootGroup } from '@/shell/explorer';
import { analyze, flattenVisible } from '@/shell/explorerModel';
import { ExplorerItem } from '@/shell/ExplorerItem';

// The workspace explorer as a keyed Preact component tree (#989 task 2, corrected in the task-2a
// follow-up). This is the Preact counterpart of `createExplorer()` in explorer.ts, which stays untouched
// (and mounted) until the facade swap (#989 task 8) — ExplorerPanel is purely additive today.
//
// STRUCTURE (task-2a): a directory's children render as a nested `<ExplorerItem>` tree — a
// `<ul class="explorer-children" role="group">` DIRECTLY inside the directory's own `<li>` — via the
// recursive `renderEntry()` below, not a flat `aria-level`-only row list. All roots share ONE
// `<ul class="explorer-tree" role="tree" aria-label="Workspace files">`; a 2+-root workspace wraps each
// root's entries in one `.explorer-group[data-root]` `<li role="treeitem">` that is itself a direct child
// of that single tree (see `renderGroupWrapper()` for why `role="treeitem"` — not explorer.ts's
// `role="none"`, and NOT `role="group"` either — is what actually keeps this axe-clean). Single-root has
// no wrapper at all — entries are direct tree children.
//
// Row visibility/filtering is delegated to explorerModel.ts's pure `analyze()` (extracted verbatim from
// explorer.ts's internal analyze() in task 1) exactly as task 2 wired it: `analyze()` supplies the
// filter-match count and the per-token `visible` set that `renderEntry()` consults while walking each
// group's entries (the "matched-dir-reveals-subtree"/"dir-counted-in-matches" rules live there).
// `flattenVisible()` is still used, but only for the empty/no-match row COUNT (its flat shape is
// irrelevant there — counting doesn't care about nesting). Each row renders as a keyed `ExplorerItem`;
// unrelated rows keep their DOM identity across a re-render — see ExplorerPanel.test.tsx's keyed-identity
// test, the assertion the rest of the #989 arc leans on to retire explorer.ts's re-render-deferral
// machinery.
//
// NOT in this task: keyboard nav (roving tabindex, arrow keys, F2/Delete), drag-and-drop move, inline
// create/rename inputs, the "…" per-row context-menu trigger, and the ADR-0009 active-context
// is-scoped/dim emphasis (explorerModel.ts's public `analyze()` doesn't carry that scope match — only
// the private analyze() inside explorer.ts does). Those land in later #989 tasks. `filterText` and the
// collapsed-directories set are component-LOCAL `useState` here; task 7 lifts them into the app store.
export interface ExplorerPanelProps {
  cb: ExplorerCallbacks;
  groups: ExplorerRootGroup[];
  /** Seed the filter field (tests/stories only) — the field is otherwise local state. */
  initialFilterText?: string;
  /** Seed the collapsed-directories set (tests/stories only). */
  initialCollapsed?: readonly string[];
}

export function ExplorerPanel(props: ExplorerPanelProps): JSX.Element {
  const { cb, groups } = props;
  const [filterInput, setFilterInput] = useState(props.initialFilterText ?? '');
  const [filterText, setFilterText] = useState(() => (props.initialFilterText ?? '').trim().toLowerCase());
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set(props.initialCollapsed ?? []));

  // Debounce the filter — 110ms, mirroring explorer.ts's `setTimeout(applyFilter, 110)` — so each
  // keystroke doesn't re-derive visibility/highlighting for the whole tree.
  useEffect(() => {
    const id = setTimeout(() => setFilterText(filterInput.trim().toLowerCase()), 110);
    return () => clearTimeout(id);
  }, [filterInput]);

  // matchCount (the filter-count chip) — the visibility SET itself comes from the per-group
  // flattenVisible() calls below, not from this pass, so this analyze() call exists for matchCount +
  // liveDirs (collapsed-set hygiene) only.
  const analysis = useMemo(() => analyze(groups, filterText, cb.isActive), [groups, filterText, cb.isActive]);

  // Prune stale collapsed tokens (a folder deleted/renamed/moved away since the last render) so the set
  // can't grow unbounded or wrongly re-collapse a brand-new folder that reuses an old token — ported from
  // explorer.ts's renderRoots(). Returns the SAME Set reference when nothing changed, so this never
  // triggers a needless extra render.
  useEffect(() => {
    setCollapsed((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const t of prev) {
        if (!analysis.liveDirs.has(t)) {
          next.delete(t);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [analysis.liveDirs]);

  // Total visible-row count across every group, for the empty/no-match state — flattenVisible()'s FLAT
  // shape doesn't matter here, only its length, so one call over every group (not one per group) is fine.
  const totalRows = useMemo(() => flattenVisible(groups, collapsed, filterText).length, [groups, collapsed, filterText]);
  const showEmpty = totalRows === 0;

  const toggleDir = (token: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(token)) next.delete(token);
      else next.add(token);
      return next;
    });
  };

  const collapseAllDirs = (): void => {
    const all = new Set<string>();
    const walk = (e: FsEntry): void => {
      if (e.kind !== 'dir') return;
      all.add(e.token);
      for (const c of e.children ?? []) walk(c);
    };
    for (const g of groups) for (const e of g.entries) walk(e);
    setCollapsed(all);
  };
  const expandAllDirs = (): void => setCollapsed(new Set());

  const filtering = filterText !== '';

  // Recursively render one entry (and, when it's an expanded directory, its own children) as a keyed
  // `ExplorerItem` — the DOM-shape fix (#989 task-2a): a directory's children nest INSIDE its own `<li>`
  // (via `ExplorerItem`'s `children` prop) rather than sitting flat beside it. Filter-visibility reuses
  // `analysis.visible` (from explorerModel.ts's `analyze()`) exactly as task 2 wired it — only the
  // render SHAPE changed here, not the visibility rule. Returns null when a filter is active and neither
  // this entry nor any descendant matches (mirrors explorer.ts's `buildItem()` early return).
  const renderEntry = (entry: FsEntry, level: number): JSX.Element | null => {
    if (filtering && !analysis.visible.has(entry.token)) return null;
    const isDir = entry.kind === 'dir';
    const expanded = isDir && (filtering || !collapsed.has(entry.token));
    const active = !isDir && cb.isActive(entry.token);
    const dirty = !isDir && cb.isDirty(entry.token);
    const diag = isDir ? { errors: 0, warnings: 0 } : cb.diagCounts(entry.token);

    // Only compute (and pass) children when this directory is actually expanded — a collapsed directory
    // simply doesn't render its subtree at all (the JS/Preact equivalent of the original's CSS
    // `display:none`), rather than building it and hiding it.
    const childNodes = isDir && expanded ? (entry.children ?? []).map((c) => renderEntry(c, level + 1)).filter(nonNull) : undefined;

    return (
      <ExplorerItem
        key={entry.token}
        token={entry.token}
        kind={entry.kind}
        name={entry.name}
        level={level}
        expanded={expanded}
        active={active}
        dirty={dirty}
        errors={diag.errors}
        warnings={diag.warnings}
        filterText={filterText}
        onToggle={() => toggleDir(entry.token)}
        onOpen={() => cb.onOpenFile(entry.token)}
      >
        {childNodes}
      </ExplorerItem>
    );
  };

  // A group's top-level rows: its entries recursively rendered, filtered rows dropped. Level 1 in
  // single-root mode (no wrapper); level 2 in multi-root mode, since the wrapper ITSELF now occupies
  // level 1 (see renderGroupWrapper below) — the top-level entries genuinely ARE one level deeper than
  // the workspace-root node that contains them, mirroring how a directory's own children are level+1.
  const renderGroupRows = (group: ExplorerRootGroup, level: number): JSX.Element[] =>
    group.entries.map((e) => renderEntry(e, level)).filter(nonNull);

  // Multi-root (2+ groups) only: one `.explorer-group[data-root]` wrapper per root, itself a direct child
  // of the single shared tree below, containing that root's header (name + Remove) and its top-level rows.
  //
  // WHY role="treeitem" (not explorer.ts's role="none", and NOT role="group" either): explorer.ts marks
  // this wrapper `role="none"` (presentational), which removes its OWN boundary from the accessibility
  // tree, so its child `.explorer-group-header` — a plain, roleless `<div>` around a real, focusable
  // Remove `<button>` — ends up exposed straight onto `ul[role="tree"]`; `tree`'s `aria-required-children`
  // check flags that bare button. The natural-seeming fix — give the wrapper `role="group"` instead —
  // does NOT actually work: axe's aria-required-children walk treats `group` (and `rowgroup`) as
  // TRANSPARENT whenever the ancestor `tree`/`grid`-family role accepts `group` as an owned role (which
  // `tree` does), so it tunnels straight through any number of nested `group`s looking for the first
  // non-group/treeitem descendant — and finds the button regardless of how many `role="group"` wrappers
  // sit between it and the tree (confirmed empirically: a `role="group"` wrapper here still fails
  // aria-required-children with the exact same "button is not allowed" violation). `role="treeitem"` is
  // NOT given that transparency treatment — it's a genuine terminal leaf for this check, exactly like
  // every ordinary file/folder row already is (a directory's own `.explorer-more` action button, in
  // explorer.ts, sits inside its `<li role="treeitem">` without tripping this same rule, for the identical
  // reason). So: treat a multi-root workspace root exactly like a folder — a `treeitem` whose "row" is
  // `.explorer-group-header` (name + Remove, playing the part `.explorer-row` plays for a real directory)
  // and whose nested `.explorer-group-items` list is its `role="group"` child (playing the part
  // `.explorer-children` plays) — verified axe-clean this way for multi-root, nested-subdirectory and
  // empty-state cases (see ExplorerPanel.test.tsx). `<li>` (matching explorer.ts's own element choice) is
  // fine here — unlike `role="group"`, `role="treeitem"` IS an axe-allowed role for `<li>` (every ordinary
  // row already relies on exactly that).
  //
  // The decorative folder-name text is `aria-hidden` (visually unchanged) so it isn't double-announced
  // alongside the wrapper's own accessible name (`aria-label`, required for `treeitem`); the Remove button
  // keeps its own accessible name via its own `aria-label` regardless of the ancestor's role.
  const renderGroupWrapper = (group: ExplorerRootGroup): JSX.Element => {
    const name = folderNameOf(group.root);
    return (
      <li
        key={group.root}
        class="explorer-group"
        role="treeitem"
        aria-level={1}
        aria-expanded="true"
        aria-label={`Files in ${name}`}
        data-root={group.root}
        tabIndex={-1}
      >
        <div class="explorer-group-header">
          <span class="explorer-group-name" aria-hidden="true">
            {name}
          </span>
          <button
            type="button"
            class="explorer-group-remove"
            aria-label={`Remove folder ${name}`}
            title={`Remove folder ${name}`}
            onClick={(e) => {
              e.stopPropagation();
              cb.onRemoveRoot?.(group.root);
            }}
          >
            ✕
          </button>
        </div>
        <ul class="explorer-group-items" role="group">
          {renderGroupRows(group, 2)}
        </ul>
      </li>
    );
  };

  const matchCount = analysis.matchCount;

  return (
    <div class="explorer">
      <div class="explorer-head">
        <div class="explorer-filter-row">
          <input
            type="search"
            class="explorer-filter"
            id="koi-explorer-filter"
            name="koi-explorer-filter"
            placeholder="Filter files…"
            aria-label="Filter workspace files"
            spellcheck={false}
            value={filterInput}
            onInput={(e) => setFilterInput((e.currentTarget as HTMLInputElement).value)}
            onKeyDown={(e) => {
              // Escape clears immediately, bypassing the debounce (matches explorer.ts).
              if (e.key === 'Escape' && filterInput) {
                e.preventDefault();
                e.stopPropagation();
                setFilterInput('');
                setFilterText('');
              }
            }}
          />
          <span class="explorer-filter-count" aria-live="polite">
            {filterText ? `${matchCount} match${matchCount === 1 ? '' : 'es'}` : ''}
          </span>
        </div>
        <div class="explorer-toolbar">
          {/* New file/New folder render for visual/DOM parity but are inert placeholders in this task —
              their real behavior (an inline-create input) is a later #989 task; wiring them to
              cb.onNewFile/onNewFolder needs a name the user hasn't typed anywhere yet. */}
          <ToolbarButton label="New file">
            <NewFileGlyph />
          </ToolbarButton>
          <ToolbarButton label="New folder">
            <NewFolderGlyph />
          </ToolbarButton>
          <ToolbarButton label="Add folder to workspace" extraClass="explorer-add-root" onClick={() => cb.onAddRoot?.()}>
            <AddRootGlyph />
          </ToolbarButton>
          <span class="explorer-toolbar-spacer" aria-hidden="true" />
          <ToolbarButton label="Collapse all" onClick={collapseAllDirs}>
            <CollapseAllGlyph />
          </ToolbarButton>
          <ToolbarButton label="Expand all" onClick={expandAllDirs}>
            <ExpandAllGlyph />
          </ToolbarButton>
        </div>
      </div>
      {showEmpty ? (
        <div class="explorer-empty">
          {filterText ? (
            `No files match “${filterInput.trim()}”.`
          ) : (
            <>
              <p class="explorer-empty-line">This folder is empty.</p>
              {/* Inert for the same reason as the toolbar's New file — no inline-create input yet. */}
              <button type="button" class="explorer-empty-action">
                New file
              </button>
            </>
          )}
        </div>
      ) : (
        // ONE shared `<ul role="tree">` for every root — matching explorer.ts's `tree` element exactly
        // (byte-identical single-root shape, and the same tree instance multi-root groups attach to) —
        // rather than task 2's per-root `role="tree"` split. A single tree is what #989's own design spec
        // requires (one delegated `onKeyDown` on `ul[role="tree"]`, so a later arrow-key nav task can cross
        // group boundaries) and what explorer.test.ts's structural assertions pin (a lone
        // `ul[role="tree"]` queried singular throughout).
        <ul class="explorer-tree" role="tree" aria-label="Workspace files">
          {groups.length <= 1 ? renderGroupRows(groups[0], 1) : groups.map(renderGroupWrapper)}
        </ul>
      )}
    </div>
  );
}

/** Type guard for filtering `null`s out of a mapped array while keeping the element type non-nullable. */
function nonNull<T>(value: T | null): value is T {
  return value !== null;
}

/** The folder name shown in a group header: the root token's last non-empty path segment. */
function folderNameOf(root: string): string {
  const segs = root.split(/[\\/]/).filter(Boolean);
  return segs.length ? segs[segs.length - 1] : root;
}

function ToolbarButton(props: {
  label: string;
  extraClass?: string;
  onClick?: () => void;
  children: ComponentChildren;
}): JSX.Element {
  return (
    <button
      type="button"
      class={props.extraClass ? `explorer-tool ${props.extraClass}` : 'explorer-tool'}
      aria-label={props.label}
      title={props.label}
      onClick={props.onClick}
    >
      <span class="explorer-tool-icon" aria-hidden="true">
        {props.children}
      </span>
    </button>
  );
}

// Toolbar glyphs, ported verbatim (same paths) from explorer.ts's TOOL_ICON as literal JSX <svg> (the
// innerHTML ban rules out reusing the original's markup-string constants — see ExplorerItem.tsx's same
// note on ItemIcon). Duplicated rather than imported: explorer.ts's TOOL_ICON/ICON are module-private,
// and explorer.ts itself must stay untouched until task 8's facade swap.
function NewFileGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M8.6 2H4.4c-.6 0-1 .4-1 1v10c0 .6.4 1 1 1h7.2c.6 0 1-.4 1-1V6z" />
      <path d="M8.6 2v4h4" />
      <path d="M8 8.3v3.4M6.3 10h3.4" />
    </svg>
  );
}

function NewFolderGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M1.9 4.4c0-.6.4-1 1-1h2.7c.3 0 .6.1.8.4l.7.9h6c.5 0 1 .4 1 1v5.5c0 .6-.5 1-1 1H2.9c-.6 0-1-.4-1-1z" />
      <path d="M8 7.6v3.3M6.4 9.2h3.3" />
    </svg>
  );
}

function CollapseAllGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
      <path d="M4.5 8.2 8 4.8l3.5 3.4" />
      <path d="M4.5 11.6 8 8.2l3.5 3.4" />
    </svg>
  );
}

function ExpandAllGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
      <path d="M4.5 4.4 8 7.8l3.5-3.4" />
      <path d="M4.5 7.8 8 11.2l3.5-3.4" />
    </svg>
  );
}

// Same path data as NewFolderGlyph in explorer.ts's TOOL_ICON (a folder-with-"+" glyph reused for the
// "add a second workspace root" affordance, distinguished by sitting alone in the toolbar).
function AddRootGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M1.9 4.4c0-.6.4-1 1-1h2.7c.3 0 .6.1.8.4l.7.9h6c.5 0 1 .4 1 1v5.5c0 .6-.5 1-1 1H2.9c-.6 0-1-.4-1-1z" />
      <path d="M8 7.6v3.3M6.4 9.2h3.3" />
    </svg>
  );
}
