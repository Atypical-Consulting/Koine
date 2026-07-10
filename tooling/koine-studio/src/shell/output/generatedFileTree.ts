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
// and fires `onSelect(path)`. `setFiles` always rebuilds from scratch (a fresh `buildFileTree` call),
// so a prior selection/collapse state does not survive a rebuild — the caller re-asserts it via
// `selectPath` if it wants a file to stay marked selected across a recompile.
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

  /** The visible (not collapsed-away) treeitems, in DOM/visual order — a row is excluded once any
   *  ancestor folder's `<ul role="group">` is `hidden`. */
  function visibleTreeItems(): HTMLElement[] {
    return Array.from(tree.querySelectorAll<HTMLElement>('[role="treeitem"]')).filter(
      (el) => el.closest('[hidden]') === null,
    );
  }

  /** Seed/refresh the roving tabindex: exactly one visible treeitem (`active`, else the first) is the
   *  lone tab stop; every other treeitem — visible or not — leaves the tab order. */
  function setRovingItem(active: HTMLElement | null): void {
    const all = Array.from(tree.querySelectorAll<HTMLElement>('[role="treeitem"]'));
    const visible = visibleTreeItems();
    const tabbable = active && visible.includes(active) ? active : (visible[0] ?? null);
    for (const item of all) item.tabIndex = item === tabbable ? 0 : -1;
  }

  function focusItem(item: HTMLElement): void {
    setRovingItem(item);
    item.focus();
  }

  /** The treeitem a DOM event targets: the event target's nearest treeitem, else the currently-focused
   *  element's (the listeners below are delegated on the root). */
  function currentTreeItem(ev: Event): HTMLElement | null {
    return (
      (ev.target as HTMLElement | null)?.closest<HTMLElement>('[role="treeitem"]') ??
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
    if (fireOnSelect) opts.onSelect(path);
  }

  function toggleFolder(li: HTMLElement): void {
    const expanded = li.getAttribute('aria-expanded') === 'true';
    li.setAttribute('aria-expanded', String(!expanded));
    const group = folderGroups.get(li);
    if (group) group.hidden = expanded; // was expanded → now collapsing → hide
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
    setRovingItem(null); // seed the first treeitem as the lone tab stop
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
