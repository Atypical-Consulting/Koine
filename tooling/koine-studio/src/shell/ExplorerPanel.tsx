import { useEffect, useMemo, useState } from 'preact/hooks';
import type { ComponentChildren, JSX } from 'preact';
import type { FsEntry } from '@/host';
import type { ExplorerCallbacks, ExplorerRootGroup } from '@/shell/explorer';
import { analyze, flattenVisible, type ExplorerFlatRow } from '@/shell/explorerModel';
import { ExplorerItem } from '@/shell/ExplorerItem';

// The workspace explorer as a keyed Preact component tree (#989 task 2: STATIC render only). This is
// the Preact counterpart of `createExplorer()` in explorer.ts, which stays untouched (and mounted) until
// the facade swap (#989 task 8) — ExplorerPanel is purely additive today.
//
// Row order/visibility/filtering is delegated to explorerModel.ts's pure `analyze()`/`flattenVisible()`
// (extracted verbatim from explorer.ts's internal analyze()/visibleItems() in task 1) rather than
// reimplemented here: `analyze()` supplies the filter-match count (the "matched-dir-reveals-subtree"/
// "dir-counted-in-matches" rules live there), and `flattenVisible()` supplies the ordered, level-tagged
// row list per root — called ONE ROOT AT A TIME so each group's rows can be nested inside that group's
// own wrapper (its internal filter-visibility computation is per-subtree already, so slicing by group
// is equivalent to filtering the combined list). Each row renders as a keyed `ExplorerItem`; unrelated
// rows keep their DOM identity across a re-render — see ExplorerPanel.test.tsx's keyed-identity test,
// the assertion the rest of the #989 arc leans on to retire explorer.ts's re-render-deferral machinery.
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

  // token -> FsEntry, so a flattened row (token/kind/level only) can recover the entry's name/children.
  const entryIndex = useMemo(() => {
    const map = new Map<string, FsEntry>();
    const walk = (e: FsEntry): void => {
      map.set(e.token, e);
      for (const c of e.children ?? []) walk(c);
    };
    for (const g of groups) for (const e of g.entries) walk(e);
    return map;
  }, [groups]);

  // One flattenVisible() call PER GROUP (not one call over all groups) so each group's rows nest inside
  // that group's own wrapper — see the module doc comment above for why this is equivalent.
  const rowsByGroup = useMemo(
    () => groups.map((g) => ({ group: g, rows: flattenVisible([g], collapsed, filterText) })),
    [groups, collapsed, filterText],
  );
  const totalRows = rowsByGroup.reduce((n, g) => n + g.rows.length, 0);
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

  const renderRow = (row: ExplorerFlatRow): JSX.Element | null => {
    const entry = entryIndex.get(row.token);
    if (!entry) return null; // defensive — flattenVisible only ever emits tokens present in entryIndex
    const isDir = entry.kind === 'dir';
    const expanded = isDir && (filterText ? true : !collapsed.has(entry.token));
    const active = !isDir && cb.isActive(entry.token);
    const dirty = !isDir && cb.isDirty(entry.token);
    const diag = isDir ? { errors: 0, warnings: 0 } : cb.diagCounts(entry.token);
    return (
      <ExplorerItem
        key={entry.token}
        token={entry.token}
        kind={entry.kind}
        name={entry.name}
        level={row.level}
        expanded={expanded}
        active={active}
        dirty={dirty}
        errors={diag.errors}
        warnings={diag.warnings}
        filterText={filterText}
        onToggle={() => toggleDir(entry.token)}
        onOpen={() => cb.onOpenFile(entry.token)}
      />
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
      ) : groups.length <= 1 ? (
        <ul class="explorer-tree" role="tree" aria-label="Workspace files">
          {(rowsByGroup[0]?.rows ?? []).map(renderRow)}
        </ul>
      ) : (
        // Multi-root: each root gets its OWN independent `role="tree"` rather than one shared tree with
        // role="group" sections. Two axe-verified reasons this diverges from a single shared tree (which
        // is what explorer.ts — never axe-tested — renders): (1) aria-required-children flags the group
        // header's interactive Remove button as soon as it's a descendant of a role=tree (a role="none"
        // wrapper doesn't exempt it — only treeitem/group are allowed owned roles); putting the header
        // OUTSIDE any tree-scoped element is the only fix. (2) axe's aria-required-parent check for
        // treeitem does NOT treat an ancestor role="group" as sufficient on its own — the group itself
        // must in turn be inside a role="tree" (see aria-core's getMissingContext), so a bare
        // role="group" section with no enclosing tree also fails. Giving each group its own role="tree"
        // satisfies both at once, and reads naturally to AT users as N separate file lists (mirrors how
        // VS Code's multi-root explorer presents one tree per workspace folder).
        <div class="explorer-tree">
          {rowsByGroup.map(({ group, rows }) => {
            const name = folderNameOf(group.root);
            return (
              <div key={group.root} class="explorer-group" data-root={group.root}>
                <div class="explorer-group-header">
                  <span class="explorer-group-name">{name}</span>
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
                <ul class="explorer-group-items" role="tree" aria-label={`Files in ${name}`}>
                  {rows.map(renderRow)}
                </ul>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
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
