// Accessible file-tree view for the "Generated output" panel (#871 task 2): renders the pure
// `TreeNode[]` model `buildFileTree` (task 1, ./fileTree.ts) produces as a vanilla-DOM WAI-ARIA
// `tree`/`treeitem` widget — no framework, no store, no host access. A standalone, self-contained
// component: nothing else wires it into the app yet (a later #871 task mounts it into the Output rail
// alongside a file-content viewer).
//
// Follows this codebase's existing tree-panel conventions (see shell/explorer.tsx's ExplorerItem and
// model/domainNavigator.ts) rather than inventing a new pattern: one `<ul role="tree">` of nested
// `<li role="treeitem">` rows, a folder's children in a directly-nested `<ul role="group">`, and
// roving-tabindex keyboard nav routed through the shared `handleTreeKeydown` router
// (shell/rovingTreeNav.ts, #1105) so ArrowUp/Down/Home/End/Enter/Space behave identically to every
// other Studio tree. Deliberately NOT a port of domainNavigator's/explorer's full machinery (drag-drop,
// rename, context menus, filtering) — this is a small, self-contained widget over one pure interface.
//
// A folder row toggles `aria-expanded` (and hides/reveals its `<ul role="group">`) on click or
// Enter/Space; a file row sets `aria-selected="true"` (clearing any prior selection — single-select)
// and fires `onSelect(path)`. `setFiles` always rebuilds from scratch (a fresh `buildFileTree` call), so
// a prior SELECTION never survives a rebuild — the caller re-asserts it via `selectPath` if it wants a
// file to stay marked selected across a recompile. Collapsed-folder state, however, DOES survive a
// rebuild for any folder path that still exists in the new tree (code-review fix): `setFiles` captures
// the currently-collapsed paths before discarding the old render and re-applies them to the matching new
// rows once built — mirroring exactly how the caller re-asserts selection via `selectPath`. This matters
// because `setFiles` is called on every successful emit, INCLUDING a live-edit re-emit (surfaceLoaders.tsx's
// `loadPreview`, ~350ms after any keystroke while this panel is visible) — without this, a user's manually
// collapsed folders would snap back open on essentially every edit. A folder whose path no longer exists
// in the new tree simply loses its (moot) collapsed state.
import type { EmitFile } from '@/lsp/protocol';
import { buildFileTree, type TreeNode } from '@/shell/output/fileTree';
import { handleTreeKeydown, type RovingTreeNav } from '@/shell/rovingTreeNav';

export interface GeneratedFileTreeOptions {
  /** Fired when a file treeitem is activated (clicked, or Enter/Space while it holds keyboard focus). */
  onSelect: (path: string) => void;
}

export interface GeneratedFileTree {
  /** The root element to mount — wraps the `<ul role="tree">`. */
  element: HTMLElement;
  /** Rebuild the tree from a fresh flat file list (via `buildFileTree`). Drops any prior selection. */
  setFiles(files: EmitFile[]): void;
  /**
   * Mark the file at `path` selected (expanding its ancestor folders so it stays visible) WITHOUT
   * firing `onSelect` — for a caller reconciling external state (e.g. re-selecting the previously
   * active file after a recompile). Returns `false` — a no-op — when `path` doesn't name a FILE node
   * in the current tree (absent entirely, or a folder path).
   */
  selectPath(path: string): boolean;
}

/**
 * Build the accessible file-tree widget. Returns an imperative handle over the rendered DOM — no
 * store, no host access, so it is trivially unit-testable and reusable wherever the compiler's
 * `EmitFile[]` output needs a browsable tree.
 */
export function createGeneratedFileTree(opts: GeneratedFileTreeOptions): GeneratedFileTree {
  const element = document.createElement('div');
  element.className = 'generated-file-tree';

  const tree = document.createElement('ul');
  element.appendChild(tree);

  // path -> its <li role="treeitem"> in the CURRENT render, and folder <li> -> its own nested
  // <ul role="group">, so click/selectPath/toggle resolve in O(1) instead of walking the DOM. Both
  // reset on every setFiles() rebuild.
  let byPath = new Map<string, HTMLElement>();
  let folderGroups = new Map<HTMLElement, HTMLUListElement>();

  /** Every treeitem in the current render, in DOM/visual order — the one `querySelectorAll` both
   *  {@link visibleTreeItems} and {@link setRovingItem} derive from, so a call that needs both the full
   *  and the visible set (setRovingItem) only ever traverses the tree once. */
  function allTreeItems(): HTMLElement[] {
    return Array.from(tree.querySelectorAll<HTMLElement>('[role="treeitem"]'));
  }

  /** The visible (not collapsed-away) treeitems, in DOM/visual order — a row is excluded once any
   *  ancestor folder's `<ul role="group">` is `hidden`. */
  function visibleTreeItems(): HTMLElement[] {
    return allTreeItems().filter((el) => el.closest('[hidden]') === null);
  }

  /** Seed/refresh the roving tabindex: exactly one visible treeitem (`active`, else the first) is the
   *  lone tab stop; every other treeitem — visible or not — leaves the tab order. */
  function setRovingItem(active: HTMLElement | null): void {
    const all = allTreeItems();
    const visible = all.filter((el) => el.closest('[hidden]') === null);
    const tabbable = active && visible.includes(active) ? active : (visible[0] ?? null);
    for (const item of all) item.tabIndex = item === tabbable ? 0 : -1;
  }

  function focusItem(item: HTMLElement): void {
    setRovingItem(item);
    item.focus();
  }

  /** The treeitem a DOM event targets: the event target's nearest treeitem, else the currently-focused
   *  element's (the listeners below are delegated on the root). Code-review fix: `ev.target` isn't always
   *  an `Element` — a row's label is a bare Text node (`buildRow` sets `li.textContent` directly, no
   *  wrapping `<span>`), and in Firefox a real mouse click landing on rendered text sets `event.target` to
   *  that Text node, which has no `.closest`. Resolve to the nearest Element first (its `.parentElement`
   *  when the target itself isn't one) before calling `.closest` on it. */
  function currentTreeItem(ev: Event): HTMLElement | null {
    const target = ev.target;
    const start = target instanceof Element ? target : ((target as Node | null)?.parentElement ?? null);
    return (
      start?.closest<HTMLElement>('[role="treeitem"]') ??
      (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('[role="treeitem"]') ??
      null
    );
  }

  function clearSelection(): void {
    for (const el of tree.querySelectorAll<HTMLElement>('[aria-selected="true"]')) {
      el.setAttribute('aria-selected', 'false');
    }
  }

  function selectFile(li: HTMLElement, path: string, fireOnSelect: boolean): void {
    clearSelection();
    li.setAttribute('aria-selected', 'true');
    // Code-review fix: a selection (a click, a keyboard activate, or a caller's selectPath) may land on a
    // row that's off-screen in the scrollable `.out-rail` viewport (e.g. a recompile falling back to the
    // first file when the previously-selected one was renamed/removed) — scroll it into view exactly like
    // ExplorerPanel.tsx's own "SCROLL RETRY" fix does for the same scenario. Optional-chained since this
    // widget builds its DOM synchronously (no Preact-async-render retry machinery needed) and jsdom/
    // happy-dom may not implement it at all.
    li.scrollIntoView?.({ block: 'nearest' });
    if (fireOnSelect) opts.onSelect(path);
  }

  /** Set a folder's expanded state directly (rather than toggling from its current state) — shared by
   *  `toggleFolder` (click/Enter/Space) and `navFor`'s `expand`/`collapse` (ArrowRight/ArrowLeft), which
   *  each already know which direction they want rather than needing a flip. */
  function setFolderExpanded(li: HTMLElement, expanded: boolean): void {
    li.setAttribute('aria-expanded', String(expanded));
    const group = folderGroups.get(li);
    if (group) group.hidden = !expanded;
  }

  function toggleFolder(li: HTMLElement): void {
    const expanded = li.getAttribute('aria-expanded') === 'true';
    setFolderExpanded(li, !expanded);
  }

  /** Activate a row exactly like a click: toggle a folder, or select a file and fire `onSelect`. Also
   *  moves the roving tab stop to it, matching the WAI-ARIA tree pattern (activation implies focus). */
  function activateItem(li: HTMLElement): void {
    if (li.dataset.kind === 'folder') {
      toggleFolder(li);
    } else {
      const path = li.dataset.path;
      if (path) selectFile(li, path, true);
    }
    focusItem(li);
  }

  function navFor(ev: KeyboardEvent): RovingTreeNav<HTMLElement> {
    const items = visibleTreeItems();
    return {
      items: () => items,
      activeIndex: () => {
        const current = currentTreeItem(ev);
        return current ? items.indexOf(current) : -1;
      },
      focusIndex: (i) => {
        const item = items[i];
        if (item) focusItem(item);
      },
      activate: (i) => {
        const item = items[i];
        if (item) activateItem(item);
        return true;
      },
      // ArrowRight — mirrors ExplorerPanel.tsx's `expand()` convention exactly (this codebase's OTHER tree
      // with real collapsible folders, per the WAI-ARIA APG): a closed folder expands IN PLACE (focus
      // stays put); an already-open folder instead moves focus to its next visible row (its first child,
      // since a folder's children are the rows immediately after it in visual order). A file row has
      // nothing to expand — like ExplorerPanel, that's still a consumed (no-op) key, not left to the
      // browser.
      expand: (i) => {
        const item = items[i];
        if (item?.dataset.kind === 'folder') {
          const expanded = item.getAttribute('aria-expanded') === 'true';
          if (!expanded) {
            setFolderExpanded(item, true);
          } else if (i < items.length - 1) {
            focusItem(items[i + 1]);
          }
        }
        return true;
      },
      // ArrowLeft — the symmetric collapse, again mirroring ExplorerPanel.tsx's `collapse()`: an open
      // folder collapses in place; anything else (a file row, or an already-collapsed folder) ascends to
      // its parent folder treeitem instead.
      collapse: (i) => {
        const item = items[i];
        const expanded = item?.dataset.kind === 'folder' && item.getAttribute('aria-expanded') === 'true';
        if (expanded && item) {
          setFolderExpanded(item, false);
        } else {
          const parent = item?.parentElement?.closest<HTMLElement>('[role="treeitem"]') ?? null;
          if (parent) focusItem(parent);
        }
        return true;
      },
    };
  }

  function buildRow(node: TreeNode, level: number): HTMLElement {
    const li = document.createElement('li');
    li.setAttribute('role', 'treeitem');
    li.setAttribute('aria-level', String(level));
    li.dataset.path = node.path;
    li.dataset.kind = node.kind;
    li.tabIndex = -1;
    li.textContent = node.name;

    if (node.kind === 'folder') {
      li.setAttribute('aria-expanded', 'true'); // folders start expanded — a generated-output tree is
      // usually small enough to browse fully open; the caller can collapse via a click/Enter.
      const group = document.createElement('ul');
      group.setAttribute('role', 'group');
      for (const child of node.children) group.appendChild(buildRow(child, level + 1));
      li.appendChild(group);
      folderGroups.set(li, group);
    } else {
      li.setAttribute('aria-selected', 'false');
    }

    byPath.set(node.path, li);
    return li;
  }

  element.addEventListener('click', (ev) => {
    const li = currentTreeItem(ev);
    if (li) activateItem(li);
  });
  element.addEventListener('keydown', (ev) => handleTreeKeydown(navFor(ev), ev));

  function setFiles(files: EmitFile[]): void {
    // Code-review fix: capture which folder PATHS are currently collapsed in the OLD render, from the OLD
    // byPath, BEFORE it's discarded below — so this rebuild can re-apply them to the matching new rows
    // once built, rather than silently snapping every folder back open (see the module doc's header note).
    const collapsedPaths = new Set<string>();
    for (const [path, li] of byPath) {
      if (li.dataset.kind === 'folder' && li.getAttribute('aria-expanded') === 'false') {
        collapsedPaths.add(path);
      }
    }

    byPath = new Map();
    folderGroups = new Map();
    const nodes = buildFileTree(files);

    if (nodes.length === 0) {
      // No rows to show: drop the tree role entirely rather than render an empty role="tree" (which
      // would violate aria-required-children and leave nothing keyboard-reachable).
      tree.removeAttribute('role');
      tree.removeAttribute('aria-label');
      tree.replaceChildren();
      return;
    }

    tree.setAttribute('role', 'tree');
    tree.setAttribute('aria-label', 'Generated files');
    tree.replaceChildren(...nodes.map((node) => buildRow(node, 1)));

    // Re-apply the captured collapsed state to whichever of those paths still resolve to a folder in the
    // NEW tree — a path that no longer exists (renamed/removed folder) simply loses its now-moot state.
    for (const path of collapsedPaths) {
      const li = byPath.get(path);
      if (li?.dataset.kind === 'folder') setFolderExpanded(li, false);
    }

    setRovingItem(null); // seed the first VISIBLE treeitem as the lone tab stop (honors the collapse above)
  }

  function selectPath(path: string): boolean {
    const li = byPath.get(path);
    if (!li || li.dataset.kind !== 'file') return false;

    // Expand every ancestor folder so the newly-selected file stays visible.
    let ancestor = li.parentElement?.closest<HTMLElement>('[role="treeitem"]') ?? null;
    while (ancestor) {
      ancestor.setAttribute('aria-expanded', 'true');
      const group = folderGroups.get(ancestor);
      if (group) group.hidden = false;
      ancestor = ancestor.parentElement?.closest<HTMLElement>('[role="treeitem"]') ?? null;
    }

    selectFile(li, path, false);
    return true;
  }

  return { element, setFiles, selectPath };
}
