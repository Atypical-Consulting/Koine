// Workspace explorer tree for Koine Studio: a pure-DOM (no framework) `role=tree` widget that
// renders the nested FsEntry hierarchy of an opened folder. The data is already sorted
// (folders-first then alpha) and pre-tokenized by the platform; the explorer never parses a token.
//
// Design thesis: this pane is the *table of contents of a domain model*, not a generic file drawer.
// Every `.koi` file is a bounded context, every folder a subdomain — so a `.koi` row carries a small
// Koine context-mark (the brand diamond), folders carry open/closed glyphs, and a filter field treats
// the tree as an index of contexts you narrow by typing.
//
// It mounts a <div class="explorer"> (the `el` field) — a head (filter field + New File / New Folder /
// Collapse-all toolbar) plus a <ul role="tree"> — into #filetree-body, and re-renders on demand.
// Directories are collapsible; file rows open on click. Entries are created inline (a new-row input),
// renamed inline, moved by drag-and-drop, and deleted behind an in-pane confirm — the explorer does
// the prompting; the actual fs work happens in the host via the ExplorerCallbacks. Dirty dot, active
// state and the error/warning badge mirror ide.ts/renderTree so the visual language stays consistent.
import type { FsEntry } from '@/host';
import { createModal, type ModalHandle } from '@/shared/overlay';

export interface ExplorerCallbacks {
  onOpenFile(fileToken: string): void;
  /** Create a file named `name` into `parentDirToken` (root folder token for the top level). */
  onNewFile(parentDirToken: string, name: string): void;
  /** Create a folder named `name` into `parentDirToken` (root folder token for the top level). */
  onNewFolder(parentDirToken: string, name: string): void;
  onRename(entry: FsEntry, newName: string): void;
  onDelete(entry: FsEntry): void;
  onDuplicate(entry: FsEntry): void;
  /** Move `entry` into the directory identified by `destDirToken` (the opened-folder token for root). */
  onMove(entry: FsEntry, destDirToken: string): void;
  isActive(fileToken: string): boolean;
  isDirty(fileToken: string): boolean;
  diagCounts(fileToken: string): { errors: number; warnings: number };
  /** Add a new folder (root) to the workspace (the head "Add folder" affordance). Optional. */
  onAddRoot?(): void;
  /** Remove the workspace root `root` (a per-group "Remove" affordance). Optional. */
  onRemoveRoot?(root: string): void;
}

/** One workspace root and the entry tree fetched for it — a render group. */
export interface ExplorerRootGroup {
  /** The opened-folder token used as the New File/Folder parent at this group's top level. */
  root: string;
  /** The pre-sorted FsEntry hierarchy under `root`. */
  entries: FsEntry[];
}

export interface Explorer {
  /** The root <div class="explorer"> (head + <ul role="tree">) to mount into #filetree-body. */
  el: HTMLElement;
  /**
   * (Re)render the whole tree as one group. `rootToken` is the opened-folder token used as the New
   * File/Folder parent at the top level. Equivalent to `renderRoots([{ root: rootToken, entries }])`.
   */
  render(entries: FsEntry[], rootToken: string): void;
  /**
   * (Re)render the tree, one GROUP per workspace root. A single group renders with NO header (its
   * entries are direct <li role="treeitem"> children of the <ul role="tree">, identical to a
   * single-root `render`); 2+ groups each get a header (folder name + a "Remove" affordance) and a
   * per-group item list whose top-level New File/Folder + drag-to-root target that group's root.
   */
  renderRoots(groups: ExplorerRootGroup[]): void;
  /**
   * Reveal the `.koi` file backing a bounded context (the cross-axis "Reveal in Files" target, #453):
   * expand its ancestor folders, scroll its row into view and highlight it. Best-effort — a context with
   * no resolvable `.koi` (matched case-insensitively by file stem) is a silent no-op. ADDITIVE: it never
   * mutates the workspace, so a missing match can't regress any file op.
   */
  revealByContext(context: string): void;
}

/** One context-menu action, shown in the right-click / "…" / empty-space menu. */
interface MenuAction {
  label: string;
  run(): void;
}

// --- glyphs ------------------------------------------------------------------
// Small inline SVGs sized to the row. `.koi` files get the brand diamond (a bounded-context node on a
// context map); directories get an open/closed folder; everything else gets a neutral document. They
// inherit `currentColor`, so the row's CSS tints them (accent for contexts, muted for the rest).
const ICON = {
  koi: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.4 14.6 8 8 14.6 1.4 8z"/></svg>',
  folder:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.7 4.4c0-.6.5-1.1 1.1-1.1h3c.4 0 .7.2.9.5l.6.9h6c.6 0 1.1.5 1.1 1.1v6c0 .6-.5 1.1-1.1 1.1H2.8c-.6 0-1.1-.5-1.1-1.1z"/></svg>',
  folderOpen:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.7 4.4c0-.6.5-1.1 1.1-1.1h3c.4 0 .7.2.9.5l.6.9h6c.6 0 1.1.5 1.1 1.1v1.1H4.5c-.5 0-1 .4-1.1.9L1.7 13z"/><path opacity=".5" d="M4.5 7.1h10.3c.5 0 .9.5.7 1l-1.2 4.3c-.1.5-.6.8-1.1.8H2.1c-.5 0-.9-.5-.7-1l1.2-4.3c.1-.5.6-.8 1.1-.8z"/></svg>',
  file: '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round" d="M4 1.9h4.8L12 5.1v9H4z"/></svg>',
};

// Toolbar action glyphs. Drawn as strokes (matching the neutral file icon) so they read clearly at
// button size: a document/folder with a "+" for the create actions, stacked chevrons for the
// fold actions — up = collapse (rows fold together), down = expand (rows open out).
const TOOL_ICON = {
  newFile:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M8.6 2H4.4c-.6 0-1 .4-1 1v10c0 .6.4 1 1 1h7.2c.6 0 1-.4 1-1V6z"/><path d="M8.6 2v4h4"/><path d="M8 8.3v3.4M6.3 10h3.4"/></svg>',
  newFolder:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M1.9 4.4c0-.6.4-1 1-1h2.7c.3 0 .6.1.8.4l.7.9h6c.5 0 1 .4 1 1v5.5c0 .6-.5 1-1 1H2.9c-.6 0-1-.4-1-1z"/><path d="M8 7.6v3.3M6.4 9.2h3.3"/></svg>',
  collapseAll:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 8.2 8 4.8l3.5 3.4"/><path d="M4.5 11.6 8 8.2l3.5 3.4"/></svg>',
  expandAll:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 4.4 8 7.8l3.5-3.4"/><path d="M4.5 7.8 8 11.2l3.5-3.4"/></svg>',
  // Add-folder: a folder outline with a "+", distinct from new-folder by sitting alone in the toolbar.
  addRoot:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M1.9 4.4c0-.6.4-1 1-1h2.7c.3 0 .6.1.8.4l.7.9h6c.5 0 1 .4 1 1v5.5c0 .6-.5 1-1 1H2.9c-.6 0-1-.4-1-1z"/><path d="M8 7.6v3.3M6.4 9.2h3.3"/></svg>',
};

export function createExplorer(cb: ExplorerCallbacks): Explorer {
  // The mounted root. Its head (filter + toolbar) sits above the `role=tree` <ul> so neither lives
  // inside the tree's ARIA scope.
  const root = document.createElement('div');
  root.className = 'explorer';

  // --- head: filter field + toolbar ------------------------------------------
  const head = document.createElement('div');
  head.className = 'explorer-head';

  const filterRow = document.createElement('div');
  filterRow.className = 'explorer-filter-row';
  const filterInput = document.createElement('input');
  filterInput.type = 'search';
  filterInput.className = 'explorer-filter';
  filterInput.placeholder = 'Filter files…';
  filterInput.setAttribute('aria-label', 'Filter workspace files');
  filterInput.spellcheck = false;
  const filterCount = document.createElement('span');
  filterCount.className = 'explorer-filter-count';
  filterCount.setAttribute('aria-live', 'polite');
  filterRow.append(filterInput, filterCount);

  const toolbar = document.createElement('div');
  toolbar.className = 'explorer-toolbar';
  // New file stays the first .explorer-tool (the host wires the top-level create off it). Create
  // actions sit left, fold actions right (a flexible spacer between the two groups).
  const newFileBtn = toolbarButton('New file', TOOL_ICON.newFile, () => beginCreate(rootToken, 'file'));
  const newFolderBtn = toolbarButton('New folder', TOOL_ICON.newFolder, () => beginCreate(rootToken, 'dir'));
  const collapseBtn = toolbarButton('Collapse all', TOOL_ICON.collapseAll, () => setAllCollapsed(true));
  const expandBtn = toolbarButton('Expand all', TOOL_ICON.expandAll, () => setAllCollapsed(false));
  // Add a second workspace root. Always available (single- or multi-root), so it sits in the head
  // toolbar rather than inside any one group. Stable `.explorer-add-root` class for wiring/tests.
  const addRootBtn = toolbarButton(
    'Add folder to workspace',
    TOOL_ICON.addRoot,
    () => cb.onAddRoot?.(),
    'explorer-add-root',
  );
  const spacer = document.createElement('span');
  spacer.className = 'explorer-toolbar-spacer';
  spacer.setAttribute('aria-hidden', 'true');
  toolbar.append(newFileBtn, newFolderBtn, addRootBtn, spacer, collapseBtn, expandBtn);

  head.append(filterRow, toolbar);

  const tree = document.createElement('ul');
  tree.className = 'explorer-tree';
  tree.setAttribute('role', 'tree');
  tree.setAttribute('aria-label', 'Workspace files');

  root.append(head, tree);

  // The PRIMARY root token (the first group's root): the toolbar New File/Folder target and the
  // tree-background drag-to-root / empty-state / root-menu destination. Per-group top-level creates and
  // drags target their OWN group's root (carried through `parentDir` / the group container), not this.
  let rootToken = '';
  // Every group's root token, so beginCreate can find the right group container for a top-level create
  // (a non-primary root isn't itself a rendered treeitem, so it's matched against this set instead).
  const rootTokens = new Set<string>();
  // The latest groups the tree was rendered from, so the filter field, Collapse-all and reveal-active
  // can re-render without the host re-supplying them.
  let lastGroups: ExplorerRootGroup[] = [];
  // The single floating context menu, lazily mounted to document.body and reused.
  let menuEl: HTMLElement | null = null;
  // The element to return focus to when the context menu closes (the row/li or '⋯').
  let menuTrigger: HTMLElement | null = null;
  // Directory tokens the user has collapsed. Honoured across re-renders so a folder doesn't pop back
  // open when the tree is rebuilt (renderTree runs on every diagnostics push).
  const collapsed = new Set<string>();
  // The lowercased filter query. When non-empty, only matching entries (and their ancestors) render,
  // and every shown directory is force-expanded so matches are always visible.
  let filterText = '';
  // The active file token we last auto-revealed (expanded ancestors + scrolled into view). Tracked so
  // a diagnostics re-render with the SAME active file doesn't re-expand folders the user just closed —
  // we only reveal when the active file actually changes.
  let revealedActive: string | null = null;
  // renderTree fires on every diagnostics push — including mid-interaction. Tearing the tree down
  // while an inline rename / inline create is open or a context menu / confirm is up would destroy the
  // input (committing a half-typed name on the resulting blur) or yank the surface out from under the
  // user. So a render that arrives during any of these is deferred and replayed once it ends.
  let renaming = false;
  let creating = false;
  let rendering = false;
  let pendingRender: { groups: ExplorerRootGroup[] } | null = null;
  // Drag-and-drop move state: the entry/li currently being dragged (null when not dragging).
  let dragEntry: FsEntry | null = null;
  let dragLi: HTMLLIElement | null = null;
  // The shared confirm dialog (built lazily on first delete) and its in-flight resolver.
  let confirmModal: ModalHandle | null = null;
  let confirmTitleEl: HTMLElement | null = null;
  let confirmMsgEl: HTMLElement | null = null;
  let confirmOkBtn: HTMLButtonElement | null = null;
  let confirmResolve: ((ok: boolean) => void) | null = null;

  // True when any modal-ish interaction is in flight (defer re-renders until it clears). A drag is
  // included: rebuilding the tree mid-drag would detach the dragged <li>, defeating the DOM-containment
  // drop-validity checks (canDropInto) and tearing down the drag's visual feedback.
  function interactionOpen(): boolean {
    return renaming || creating || dragEntry != null || menuEl != null || (confirmModal?.isOpen ?? false);
  }

  // --- name validation --------------------------------------------------------

  // A name is one path segment. Reject path separators and the `.`/`..` traversal names so a prompt
  // can't escape the folder (or, for rename, become a cross-directory move) from a single-name input.
  function invalidSegment(name: string): boolean {
    return name.includes('/') || name.includes('\\') || name === '.' || name === '..';
  }

  // The directory a New File/Folder should land in for a given row: the entry itself when it is a
  // directory, otherwise its containing directory. The container is captured from the tree structure
  // at build time (`parentDir`) — never parsed out of the opaque token, which keeps the explorer
  // token-agnostic and correct regardless of the host's path separator.
  function parentDirOf(entry: FsEntry, parentDir: string): string {
    return entry.kind === 'dir' ? entry.token : parentDir;
  }

  // --- filtering & per-render analysis ----------------------------------------

  function nameMatches(entry: FsEntry): boolean {
    return entry.name.toLowerCase().includes(filterText);
  }

  interface Analysis {
    /** Tokens to render under the active filter (unused when the filter is empty). */
    visible: Set<string>;
    /** Every directory token currently in the tree, used to prune stale entries from `collapsed`. */
    liveDirs: Set<string>;
    /** Entries (file OR dir) whose name matches the filter — what the count chip reports. */
    matchCount: number;
    /** The active file and its ancestor directory tokens (for auto-reveal), or null. */
    active: { token: string; ancestors: string[] } | null;
  }

  // The analysis from the in-progress render, consulted by buildItem (filter visibility + active row)
  // so it doesn't re-walk the tree or re-call cb.isActive per node.
  let currentAnalysis: Analysis = { visible: new Set(), liveDirs: new Set(), matchCount: 0, active: null };

  // ONE pre-render pass over the tree computing everything render() and buildItem need: filter
  // visibility, the live dir tokens, the filter match count, and the active file + its ancestor chain.
  // Replaces the former separate per-node subtreeMatches, whole-tree countFileMatches, and activePath
  // walks (which were O(n²) and duplicated cb.isActive). A directory whose OWN name matches reveals its
  // whole subtree (so a matched folder isn't shown empty); the count includes matched dirs (so the chip
  // never reads "0 matches" beside a visible folder).
  function analyze(entries: FsEntry[]): Analysis {
    const visible = new Set<string>();
    const liveDirs = new Set<string>();
    let matchCount = 0;
    let active: { token: string; ancestors: string[] } | null = null;
    const filtering = filterText !== '';

    // Returns whether `e` (or a descendant) is visible under the filter. `ancestorMatched` is true when
    // an ancestor directory's own name matched — that reveals the entire subtree beneath it.
    const walk = (e: FsEntry, ancestors: string[], ancestorMatched: boolean): boolean => {
      if (e.kind === 'dir') liveDirs.add(e.token);
      const selfMatch = filtering && nameMatches(e);
      if (selfMatch) matchCount++;
      if (e.kind === 'file' && !active && cb.isActive(e.token)) active = { token: e.token, ancestors };

      const childAncestors = e.kind === 'dir' ? [...ancestors, e.token] : ancestors;
      let descendantVisible = false;
      for (const c of e.children ?? []) {
        if (walk(c, childAncestors, ancestorMatched || selfMatch)) descendantVisible = true;
      }

      const isVisible = !filtering || selfMatch || descendantVisible || ancestorMatched;
      if (filtering && isVisible) visible.add(e.token);
      return isVisible;
    };
    for (const e of entries) walk(e, [], false);
    return { visible, liveDirs, matchCount, active };
  }

  // --- rows -------------------------------------------------------------------

  // Build one treeitem <li> for an entry, recursing into directory children. `level` drives the
  // ARIA aria-level and the visual indent; `parentDir` is the token of the containing directory
  // (the opened-folder token at the top level) so New File/Folder targets the right place. Returns
  // null when a filter is active and neither the entry nor any descendant matches.
  function buildItem(entry: FsEntry, level: number, parentDir: string): HTMLLIElement | null {
    if (filterText && !currentAnalysis.visible.has(entry.token)) return null;

    const li = document.createElement('li');
    li.setAttribute('role', 'treeitem');
    li.setAttribute('aria-level', String(level));
    li.dataset.kind = entry.kind;

    // The <li> (role=treeitem) is the focusable unit — focusing it gives assistive tech the
    // treeitem's name, level and expanded/selected state. Roving tabindex is managed by the
    // keyboard handler; the token lets focus-restore recover the same row after a re-render.
    li.tabIndex = -1;
    li.dataset.token = entry.token;

    const row = document.createElement('div');
    row.className = 'explorer-row';
    row.style.setProperty('--depth', String(level - 1));

    const isDir = entry.kind === 'dir';
    const expanded = isDir && (filterText ? true : !collapsed.has(entry.token));

    // Twisty: an expand/collapse toggle for directories, a spacer for files (keeps names aligned).
    const twisty = document.createElement('span');
    twisty.className = 'explorer-twisty';
    twisty.setAttribute('aria-hidden', 'true');
    if (isDir) twisty.textContent = expanded ? '▾' : '▸';
    row.appendChild(twisty);

    // Type icon: brand diamond for .koi contexts, open/closed folder for dirs, neutral doc otherwise.
    const { svg: iconHtml, modifier: iconMod } = classifyIcon(entry, expanded);
    const icon = document.createElement('span');
    icon.className = 'explorer-icon ' + iconMod;
    icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML = iconHtml;
    row.appendChild(icon);

    const label = document.createElement('span');
    label.className = 'explorer-name';
    fillName(label, entry.name);
    row.appendChild(label);

    if (!isDir) {
      // Dirty dot — mirrors .tree-dirty in ide.ts/renderTree. Kept as a sibling of the name span
      // (not inside it) so `.explorer-name` textContent stays the bare filename.
      if (cb.isDirty(entry.token)) {
        const dot = document.createElement('span');
        dot.className = 'tree-dirty';
        dot.title = 'Unsaved changes';
        dot.textContent = '•';
        row.appendChild(dot);
      }
      if (currentAnalysis.active?.token === entry.token) {
        // aria-selected expresses the active treeitem per the WAI-ARIA tree pattern; aria-current
        // on the row drives the visual highlight (mirrors ide.ts/renderTree).
        row.setAttribute('aria-current', 'true');
        li.setAttribute('aria-selected', 'true');
      }

      const { errors, warnings } = cb.diagCounts(entry.token);
      if (errors || warnings) {
        const badge = document.createElement('span');
        badge.className = errors ? 'tree-badge tree-badge-err' : 'tree-badge tree-badge-warn';
        badge.textContent = String(errors || warnings);
        badge.title = `${errors} error(s), ${warnings} warning(s)`;
        row.appendChild(badge);
      }
    }

    // Per-row "…" action button (keyboard/AT-friendly alternative to right-click).
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'explorer-more';
    more.textContent = '⋯';
    more.tabIndex = -1;
    more.setAttribute('aria-label', `Actions for ${entry.name}`);
    more.draggable = false;
    more.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const rect = more.getBoundingClientRect();
      openMenu(entry, parentDir, rect.left, rect.bottom);
    });
    row.appendChild(more);

    li.appendChild(row);

    if (isDir) {
      li.setAttribute('aria-expanded', String(expanded));
      const childList = document.createElement('ul');
      childList.className = 'explorer-children';
      childList.setAttribute('role', 'group');
      for (const child of entry.children ?? []) {
        const childLi = buildItem(child, level + 1, entry.token);
        if (childLi) childList.appendChild(childLi);
      }
      li.appendChild(childList);

      twisty.addEventListener('click', (ev) => {
        ev.stopPropagation();
        toggleDir(li);
      });
      row.addEventListener('click', () => toggleDir(li));
    } else {
      row.addEventListener('click', () => cb.onOpenFile(entry.token));
    }

    row.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      openMenu(entry, parentDir, ev.clientX, ev.clientY);
    });
    li.addEventListener('keydown', (ev) => onRowKeydown(ev, li, entry, parentDir));
    wireDrag(row, li, entry);
    // Store the entry + owning <li> so keyboard nav, inline rename and focus-restore recover them.
    (row as RowEl)._entry = entry;
    (row as RowEl)._li = li;
    return li;
  }

  // The icon SVG + colour modifier for an entry: brand diamond for .koi contexts, open/closed folder
  // for dirs, neutral doc otherwise. One classifier so the type rule lives in a single place.
  function classifyIcon(entry: FsEntry, expanded: boolean): { svg: string; modifier: string } {
    if (entry.kind === 'dir') {
      return { svg: expanded ? ICON.folderOpen : ICON.folder, modifier: 'explorer-icon--dir' };
    }
    const koi = entry.name.toLowerCase().endsWith('.koi');
    return { svg: koi ? ICON.koi : ICON.file, modifier: koi ? 'explorer-icon--koi' : 'explorer-icon--file' };
  }

  // Render a filename into the label, wrapping the filter match in <mark> so the user sees WHY a row
  // survived the filter. With no filter (or no match) the label is plain text.
  function fillName(label: HTMLElement, name: string): void {
    label.textContent = '';
    const at = filterText ? name.toLowerCase().indexOf(filterText) : -1;
    if (at < 0) {
      label.textContent = name;
      return;
    }
    label.append(name.slice(0, at));
    const hit = document.createElement('mark');
    hit.className = 'explorer-hl';
    hit.textContent = name.slice(at, at + filterText.length);
    label.append(hit, name.slice(at + filterText.length));
  }

  // Expand/collapse a directory <li> (toggles aria-expanded; CSS hides .explorer-children).
  function toggleDir(li: HTMLLIElement): void {
    setExpanded(li, li.getAttribute('aria-expanded') !== 'true');
  }

  function setExpanded(li: HTMLLIElement, expanded: boolean): void {
    li.setAttribute('aria-expanded', String(expanded));
    const twisty = li.querySelector<HTMLElement>(':scope > .explorer-row > .explorer-twisty');
    if (twisty) twisty.textContent = expanded ? '▾' : '▸';
    // Swap the folder glyph open/closed to match.
    const icon = li.querySelector<HTMLElement>(':scope > .explorer-row > .explorer-icon');
    if (icon) icon.innerHTML = expanded ? ICON.folderOpen : ICON.folder;
    // Persist so the folder keeps its state across re-renders (renderTree runs on every diag push).
    const token = li.dataset.token;
    if (token) {
      if (expanded) collapsed.delete(token);
      else collapsed.add(token);
    }
  }

  // Collapse (true) or expand (false) every directory in the tree, then re-render.
  function setAllCollapsed(collapse: boolean): void {
    const walk = (e: FsEntry): void => {
      if (e.kind !== 'dir') return;
      if (collapse) collapsed.add(e.token);
      else collapsed.delete(e.token);
      for (const c of e.children ?? []) walk(c);
    };
    for (const g of lastGroups) for (const e of g.entries) walk(e);
    renderRoots(lastGroups);
  }

  // --- keyboard navigation (WAI-ARIA tree pattern) ----------------------------

  // Every visible (not inside a collapsed ancestor) treeitem <li>, in DOM/visual order. In multi-root
  // mode the treeitems live one level down (inside each group's <ul.explorer-group-items>); descend
  // through those wrappers so keyboard nav crosses group boundaries in visual order.
  function visibleItems(): HTMLLIElement[] {
    const out: HTMLLIElement[] = [];
    const walk = (list: HTMLElement): void => {
      for (const child of Array.from(list.children) as HTMLElement[]) {
        // A group wrapper (multi-root) holds its own items list — recurse into it, not past it.
        if (child.classList.contains('explorer-group')) {
          const items = child.querySelector<HTMLElement>(':scope > .explorer-group-items');
          if (items) walk(items);
          continue;
        }
        if (child.getAttribute('role') !== 'treeitem') continue;
        const li = child as HTMLLIElement;
        out.push(li);
        if (li.dataset.kind === 'dir' && li.getAttribute('aria-expanded') === 'true') {
          const group = li.querySelector<HTMLElement>(':scope > .explorer-children');
          if (group) walk(group);
        }
      }
    };
    walk(tree);
    return out;
  }

  // Move roving focus to `li` (a single tabbable treeitem at a time, per the tree pattern).
  function focusItem(li: HTMLLIElement): void {
    for (const item of tree.querySelectorAll<HTMLElement>('li[role="treeitem"]')) item.tabIndex = -1;
    li.tabIndex = 0;
    li.focus();
  }

  function onRowKeydown(ev: KeyboardEvent, li: HTMLLIElement, entry: FsEntry, parentDir: string): void {
    // Each nested treeitem <li> is a DOM descendant of its ancestor directory <li>s, which also carry
    // this handler. Stop here so a keydown on a nested row isn't re-run for every ancestor (which
    // would move focus by the wrong index). The innermost (focused) li handles the event.
    ev.stopPropagation();
    const items = visibleItems();
    const idx = items.indexOf(li);
    const isDir = entry.kind === 'dir';

    switch (ev.key) {
      case 'ArrowDown':
        ev.preventDefault();
        if (idx >= 0 && idx < items.length - 1) focusItem(items[idx + 1]);
        break;
      case 'ArrowUp':
        ev.preventDefault();
        if (idx > 0) focusItem(items[idx - 1]);
        break;
      case 'ArrowRight':
        ev.preventDefault();
        if (isDir) {
          if (li.getAttribute('aria-expanded') !== 'true') setExpanded(li, true);
          else if (idx >= 0 && idx < items.length - 1) focusItem(items[idx + 1]);
        }
        break;
      case 'ArrowLeft':
        ev.preventDefault();
        if (isDir && li.getAttribute('aria-expanded') === 'true') {
          setExpanded(li, false);
        } else {
          const parent = parentItemOf(li);
          if (parent) focusItem(parent);
        }
        break;
      case 'Enter':
        ev.preventDefault();
        if (isDir) toggleDir(li);
        else cb.onOpenFile(entry.token);
        break;
      case 'F2':
        ev.preventDefault();
        startRename(li, entry);
        break;
      case 'Delete':
        ev.preventDefault();
        void confirmDelete(entry);
        break;
      case 'ContextMenu': {
        ev.preventDefault();
        const r = li.getBoundingClientRect();
        openMenu(entry, parentDir, r.left, r.bottom);
        break;
      }
    }
  }

  function parentItemOf(li: HTMLLIElement): HTMLLIElement | null {
    const group = li.parentElement; // .explorer-children or the root tree
    if (!group || !group.classList.contains('explorer-children')) return null;
    const parentLi = group.parentElement as HTMLLIElement | null;
    if (!parentLi || parentLi.getAttribute('role') !== 'treeitem') return null;
    return parentLi;
  }

  // --- drag-and-drop move -----------------------------------------------------
  // Every row is draggable AND a drop target; the empty tree background drops to the opened-folder
  // root. A directory accepts a drop INTO itself; a file accepts into its parent directory (drop
  // "next to" it), so a drop onto a file row is never a dead zone. Validity is checked structurally
  // via DOM containment (a token is opaque, so we can't parse ancestry): a drop is rejected onto the
  // dragged row itself, into its own subtree, or back into the dragged item's current parent.

  function wireDrag(row: HTMLElement, li: HTMLLIElement, entry: FsEntry): void {
    row.draggable = true;
    row.addEventListener('dragstart', (ev) => {
      // A rename/create input owns its own text drag; don't start a row move from inside it.
      if (row.querySelector('.explorer-rename')) {
        ev.preventDefault();
        return;
      }
      dragEntry = entry;
      dragLi = li;
      li.classList.add('is-dragging');
      ev.dataTransfer?.setData('text/plain', entry.name);
      if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'move';
    });
    row.addEventListener('dragend', endDrag);

    row.addEventListener('dragover', (ev) => {
      const destLi = dropDirOf(li, entry);
      if (!canDropTo(destLi)) return;
      ev.preventDefault();
      ev.stopPropagation();
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
      clearDropMarks();
      markDropTarget(destLi);
    });
    row.addEventListener('dragleave', clearDropMarks);
    row.addEventListener('drop', (ev) => {
      const destLi = dropDirOf(li, entry);
      if (!canDropTo(destLi)) return;
      ev.preventDefault();
      ev.stopPropagation();
      const moved = dragEntry;
      clearDropMarks();
      if (moved) cb.onMove(moved, destLi?.dataset.token ?? rootToken);
      endDrag(); // don't wait for dragend, which may not fire after a synthetic/edge drop
    });
  }

  // The destination directory for a drop onto `li`: the directory itself, a file's parent directory,
  // or null for the opened-folder root (a top-level row has no parent treeitem).
  function dropDirOf(li: HTMLLIElement, entry: FsEntry): HTMLLIElement | null {
    return entry.kind === 'dir' ? li : parentItemOf(li);
  }

  // Can the in-flight drag drop into `destLi` (null = the opened-folder root)? No self-drop, no drop
  // into the dragged subtree, and no no-op back into the dragged item's current parent.
  function canDropTo(destLi: HTMLLIElement | null): boolean {
    if (!dragEntry || !dragLi) return false;
    if (destLi === null) return parentItemOf(dragLi) !== null; // already at root → no-op
    if (destLi === dragLi) return false; // onto itself
    if (dragLi.contains(destLi)) return false; // into its own descendant
    if (parentItemOf(dragLi) === destLi) return false; // already a direct child → no-op
    return true;
  }

  function markDropTarget(destLi: HTMLLIElement | null): void {
    if (destLi) destLi.querySelector(':scope > .explorer-row')?.classList.add('is-drop-target');
    else tree.classList.add('is-drop-root');
  }

  function clearDropMarks(): void {
    for (const el of tree.querySelectorAll('.is-drop-target')) el.classList.remove('is-drop-target');
    tree.classList.remove('is-drop-root');
  }

  // Clear the drag state and replay any render deferred during the drag. Idempotent: runs on both
  // `dragend` and a successful `drop`, so a missing dragend can't strand `dragEntry` and freeze
  // every later diagnostics re-render.
  function endDrag(): void {
    dragLi?.classList.remove('is-dragging');
    clearDropMarks();
    dragEntry = null;
    dragLi = null;
    flushPendingRender();
  }

  // The tree background is a drop target for "move to root".
  tree.addEventListener('dragover', (ev) => {
    if ((ev.target as HTMLElement).closest('.explorer-row')) return; // a row handles its own dragover
    if (!canDropTo(null)) return;
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
    clearDropMarks();
    tree.classList.add('is-drop-root');
  });
  tree.addEventListener('dragleave', (ev) => {
    if (ev.target === tree) tree.classList.remove('is-drop-root');
  });
  tree.addEventListener('drop', (ev) => {
    if ((ev.target as HTMLElement).closest('.explorer-row')) return;
    if (!canDropTo(null)) return;
    ev.preventDefault();
    const moved = dragEntry;
    clearDropMarks();
    if (moved) cb.onMove(moved, rootToken);
    endDrag();
  });

  // --- inline create ----------------------------------------------------------

  // Insert a transient input row under `parentDirToken` (the root tree for the top level) and create
  // the file/folder from what the user types. Enter commits via cb.onNewFile/onNewFolder; Escape or an
  // empty blur cancels. The subsequent host refresh re-renders the tree, replacing this temp row.
  function beginCreate(parentDirToken: string, kind: 'file' | 'dir'): void {
    closeMenu();
    if (creating || renaming) return;

    let container: HTMLElement;
    let depth = 0;
    if (rootTokens.has(parentDirToken)) {
      // A top-level create for a workspace root: in single-root mode this is the tree itself; in
      // multi-root mode it's that group's own item list (matched by its data-root), so the inline row
      // appears under the right group. Falls back to the tree if the group container isn't found.
      const groupItems =
        parentDirToken === rootToken
          ? null
          : tree.querySelector<HTMLElement>(
              `.explorer-group[data-root="${cssEscape(parentDirToken)}"] > .explorer-group-items`,
            );
      container = groupItems ?? tree;
    } else {
      const dirLi = tree.querySelector<HTMLLIElement>(
        `li[role="treeitem"][data-kind="dir"][data-token="${cssEscape(parentDirToken)}"]`,
      );
      if (!dirLi) {
        container = tree;
      } else {
        setExpanded(dirLi, true);
        const group = dirLi.querySelector<HTMLElement>(':scope > .explorer-children');
        container = group ?? tree;
        // The create row sits one level below the parent dir. Read the parent's structural depth from
        // its aria-level (the model `level`), not the --depth presentation variable: a child row's
        // `--depth` equals its parent's aria-level (row --depth = level - 1, child level = level + 1).
        depth = Number(dirLi.getAttribute('aria-level') || 1);
      }
    }

    creating = true;
    const li = document.createElement('li');
    li.className = 'explorer-create-li';
    const row = document.createElement('div');
    row.className = 'explorer-row explorer-create';
    row.style.setProperty('--depth', String(depth));

    const twisty = document.createElement('span');
    twisty.className = 'explorer-twisty';
    twisty.setAttribute('aria-hidden', 'true');
    row.appendChild(twisty);

    const icon = document.createElement('span');
    icon.className = 'explorer-icon ' + (kind === 'dir' ? 'explorer-icon--dir' : 'explorer-icon--koi');
    icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML = kind === 'dir' ? ICON.folder : ICON.koi;
    row.appendChild(icon);

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'explorer-rename';
    input.placeholder = kind === 'dir' ? 'folder name' : 'name.koi';
    input.setAttribute('aria-label', kind === 'dir' ? 'New folder name' : 'New file name');
    input.spellcheck = false;
    row.appendChild(input);

    li.appendChild(row);
    container.prepend(li);

    wireInlineEdit(input, {
      onCommit: (raw) => {
        creating = false;
        li.remove();
        if (kind === 'dir') cb.onNewFolder(parentDirToken, raw);
        else cb.onNewFile(parentDirToken, raw);
        flushPendingRender();
      },
      onCancel: () => {
        creating = false;
        li.remove();
        flushPendingRender();
      },
    });

    input.focus();
  }

  function markInvalid(input: HTMLInputElement): void {
    input.classList.add('is-invalid');
    input.title = 'A name can’t contain “/”, “\\”, “.” or “..”.';
  }

  // Shared lifecycle for an inline-edit <input> (create + rename). Enter commits a valid name via
  // onCommit(raw); an invalid name is flagged and the row stays open to fix; an empty name — or
  // Escape — cancels. Blur commits a valid name, otherwise cancels, so the user is never trapped in
  // a bad-name row. Typing clears the invalid mark. The first commit/cancel wins; onCommit/onCancel
  // own their own teardown (row removal / label restore, flushPendingRender, focus).
  function wireInlineEdit(
    input: HTMLInputElement,
    handlers: { onCommit: (raw: string) => void; onCancel: () => void },
  ): void {
    let done = false;
    const cancel = (): void => {
      if (done) return;
      done = true;
      handlers.onCancel();
    };
    const tryCommit = (): void => {
      if (done) return;
      const raw = input.value.trim();
      if (!raw) return cancel();
      if (invalidSegment(raw)) {
        markInvalid(input);
        return; // keep the row open so the user can fix it
      }
      done = true;
      handlers.onCommit(raw);
    };
    input.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter') {
        ev.preventDefault();
        tryCommit();
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        cancel();
      }
    });
    input.addEventListener('input', () => input.classList.remove('is-invalid'));
    input.addEventListener('blur', () => {
      const raw = input.value.trim();
      if (raw && !invalidSegment(raw)) tryCommit();
      else cancel();
    });
  }

  // --- inline rename ----------------------------------------------------------

  // Replace the row's label with an <input> preselecting the basename. Enter/blur commits via
  // cb.onRename(entry, newName); Escape cancels and restores the label.
  function startRename(li: HTMLLIElement, entry: FsEntry): void {
    const row = li.querySelector<RowEl>(':scope > .explorer-row');
    const label = row?.querySelector<HTMLElement>('.explorer-name');
    if (!row || !label) return;
    if (row.querySelector('.explorer-rename')) return; // already renaming

    const input = document.createElement('input');
    input.className = 'explorer-rename';
    input.type = 'text';
    input.value = entry.name;
    input.setAttribute('aria-label', `Rename ${entry.name}`);
    input.spellcheck = false;
    label.replaceWith(input);
    renaming = true; // defer diagnostics-driven re-renders so the tree isn't torn down mid-edit
    row.draggable = false; // let the input own text selection instead of starting a row drag

    // Restore the row to its non-editing state (shared by commit and cancel). An invalid name on
    // blur cancels (label restored) rather than staying open — otherwise `renaming` would stay true
    // and freeze every later re-render; Enter still keeps an invalid name open for correction.
    const teardown = (): void => {
      renaming = false;
      row.draggable = true;
      input.replaceWith(label);
      li.tabIndex = 0;
      li.focus();
    };
    wireInlineEdit(input, {
      onCommit: (raw) => {
        teardown();
        if (raw !== entry.name) cb.onRename(entry, raw);
        flushPendingRender(); // catch up on any render that arrived while renaming
      },
      onCancel: () => {
        teardown();
        flushPendingRender();
      },
    });

    input.focus();
    // Preselect the basename (the stem before the final dot) for files, the whole name for dirs.
    const dot = entry.kind === 'file' ? entry.name.lastIndexOf('.') : -1;
    input.setSelectionRange(0, dot > 0 ? dot : entry.name.length);
  }

  // --- delete (in-pane confirm) ----------------------------------------------

  async function confirmDelete(entry: FsEntry): Promise<void> {
    const what = entry.kind === 'dir' ? 'folder and everything in it' : 'file';
    const ok = await openConfirm(
      `Delete ${entry.name}?`,
      `This removes the ${what}. It can’t be undone.`,
      'Delete',
    );
    if (ok) cb.onDelete(entry);
  }

  // The shared confirm dialog, built once on first use atop createModal() so it joins the app's
  // overlay Esc-stack and reuses its focus trap + focus restore (rather than a bespoke modal).
  function ensureConfirmModal(): ModalHandle {
    if (confirmModal) return confirmModal;
    const modal = createModal({ title: 'Confirm', ariaLabel: 'Confirm' });
    confirmTitleEl = modal.backdrop.querySelector<HTMLElement>('.koi-modal-title');
    confirmMsgEl = document.createElement('p');
    confirmMsgEl.className = 'explorer-confirm-msg';
    modal.body.appendChild(confirmMsgEl);

    const footer = modal.backdrop.querySelector<HTMLElement>('.koi-modal-footer')!;
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'explorer-confirm-btn';
    cancelBtn.textContent = 'Cancel';
    confirmOkBtn = document.createElement('button');
    confirmOkBtn.type = 'button';
    confirmOkBtn.className = 'explorer-confirm-btn explorer-confirm-btn-danger';
    footer.append(cancelBtn, confirmOkBtn);

    cancelBtn.addEventListener('click', () => settleConfirm(false));
    confirmOkBtn.addEventListener('click', () => settleConfirm(true));
    // Esc / backdrop / ✕ all route through createModal.close → here: resolve false (if still pending)
    // and replay any diagnostics render that was deferred while the dialog was up.
    modal.onClose(() => {
      resolveConfirm(false);
      flushPendingRender();
    });
    confirmModal = modal;
    return modal;
  }

  function settleConfirm(ok: boolean): void {
    resolveConfirm(ok); // resolve first so the onClose handler sees nothing pending
    confirmModal?.close();
  }

  function resolveConfirm(ok: boolean): void {
    const resolve = confirmResolve;
    confirmResolve = null;
    resolve?.(ok);
  }

  // Resolves true on confirm, false on cancel/Escape/backdrop. Diagnostics re-renders are deferred
  // while it is open (interactionOpen() consults confirmModal.isOpen).
  function openConfirm(title: string, message: string, confirmLabel: string): Promise<boolean> {
    closeMenu();
    const modal = ensureConfirmModal();
    resolveConfirm(false); // settle any stale promise defensively before reusing the dialog
    if (confirmTitleEl) confirmTitleEl.textContent = title;
    if (confirmMsgEl) confirmMsgEl.textContent = message;
    if (confirmOkBtn) confirmOkBtn.textContent = confirmLabel;
    return new Promise<boolean>((resolve) => {
      confirmResolve = resolve;
      modal.open();
      confirmOkBtn?.focus(); // default focus on the action button (createModal focuses ✕ otherwise)
    });
  }

  // --- context menu -----------------------------------------------------------

  function closeMenu(): void {
    if (menuEl) {
      menuEl.remove();
      menuEl = null;
    }
    document.removeEventListener('pointerdown', onDocPointerDown, true);
    document.removeEventListener('keydown', onMenuKeydown, true);
    // Return focus to whatever opened the menu (the treeitem / '⋯' button) so keyboard/AT users
    // are not dropped onto document.body when the menu dismisses.
    if (menuTrigger && menuTrigger.isConnected) menuTrigger.focus();
    menuTrigger = null;
    // A diagnostics re-render may have been deferred while the menu was open; replay it now (skipped
    // when called from within render(), where `rendering` is set).
    flushPendingRender();
  }

  function onDocPointerDown(ev: PointerEvent): void {
    if (menuEl && !menuEl.contains(ev.target as Node)) closeMenu();
  }

  function onMenuKeydown(ev: KeyboardEvent): void {
    if (!menuEl) return;
    const items = Array.from(menuEl.querySelectorAll<HTMLElement>('.explorer-menu-item'));
    const active = document.activeElement as HTMLElement | null;
    const i = active ? items.indexOf(active) : -1;
    if (ev.key === 'Escape' || ev.key === 'Tab') {
      // Tab (per the APG menu pattern) and Escape both dismiss the menu rather than leaving it
      // orphaned with focus elsewhere.
      ev.preventDefault();
      closeMenu();
    } else if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      items[Math.min(items.length - 1, i + 1)]?.focus();
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      items[Math.max(0, i - 1)]?.focus();
    } else if (ev.key === 'Home') {
      ev.preventDefault();
      items[0]?.focus();
    } else if (ev.key === 'End') {
      ev.preventDefault();
      items[items.length - 1]?.focus();
    }
  }

  // Open the floating menu of actions for `entry` at viewport coords (x, y). `parentDir` is the
  // entry's containing-directory token (captured at build time), the New File/Folder target.
  function openMenu(entry: FsEntry, parentDir: string, x: number, y: number): void {
    closeMenu();
    const parent = parentDirOf(entry, parentDir);
    const actions: MenuAction[] = [
      { label: 'New File', run: () => beginCreate(parent, 'file') },
      { label: 'New Folder', run: () => beginCreate(parent, 'dir') },
      { label: 'Rename', run: () => renameEntryByToken(entry) },
      { label: 'Duplicate', run: () => cb.onDuplicate(entry) },
      { label: 'Delete', run: () => void confirmDelete(entry) },
    ];
    spawnMenu(actions, x, y);
  }

  // Open the empty-space menu (right-click on the tree background) targeting the opened folder.
  function openRootMenu(x: number, y: number): void {
    closeMenu();
    const actions: MenuAction[] = [
      { label: 'New File', run: () => beginCreate(rootToken, 'file') },
      { label: 'New Folder', run: () => beginCreate(rootToken, 'dir') },
    ];
    spawnMenu(actions, x, y);
  }

  function spawnMenu(actions: MenuAction[], x: number, y: number): void {
    const menu = document.createElement('ul');
    menu.className = 'explorer-menu';
    menu.setAttribute('role', 'menu');
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    for (const action of actions) {
      const li = document.createElement('li');
      li.setAttribute('role', 'none');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'explorer-menu-item';
      btn.setAttribute('role', 'menuitem');
      btn.textContent = action.label;
      btn.addEventListener('click', () => {
        closeMenu();
        action.run();
      });
      li.appendChild(btn);
      menu.appendChild(li);
    }
    // Remember the trigger (the focused treeitem or '⋯' button) so closeMenu can restore focus.
    menuTrigger = document.activeElement as HTMLElement | null;
    document.body.appendChild(menu);
    menuEl = menu;
    menu.querySelector<HTMLElement>('.explorer-menu-item')?.focus();
    document.addEventListener('pointerdown', onDocPointerDown, true);
    document.addEventListener('keydown', onMenuKeydown, true);
  }

  // Locate the live <li> for an entry (by token) and start inline rename on it.
  function renameEntryByToken(entry: FsEntry): void {
    const rows = tree.querySelectorAll<RowEl>('.explorer-row');
    for (const row of rows) {
      if (row._entry?.token === entry.token && row._li) {
        startRename(row._li, entry);
        return;
      }
    }
  }

  // Right-click on the tree background (not a row) opens the root menu.
  tree.addEventListener('contextmenu', (ev) => {
    if ((ev.target as HTMLElement).closest('.explorer-row')) return;
    ev.preventDefault();
    openRootMenu(ev.clientX, ev.clientY);
  });

  // Filter field: re-render on input (debounced — each keystroke would otherwise rebuild the whole
  // tree); Escape clears immediately (and keeps focus in the field).
  let filterTimer: ReturnType<typeof setTimeout> | undefined;
  const applyFilter = (): void => {
    filterText = filterInput.value.trim().toLowerCase();
    renderRoots(lastGroups);
  };
  filterInput.addEventListener('input', () => {
    clearTimeout(filterTimer);
    filterTimer = setTimeout(applyFilter, 110);
  });
  filterInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && filterInput.value) {
      ev.preventDefault();
      ev.stopPropagation();
      clearTimeout(filterTimer);
      filterInput.value = '';
      applyFilter();
    }
  });

  // --- render -----------------------------------------------------------------

  // Single-root render: the byte-identical legacy entry point. One group with NO header — the entries
  // are direct <li role="treeitem"> children of <ul role="tree">, exactly as before multi-root.
  function render(entries: FsEntry[], token: string): void {
    renderRoots([{ root: token, entries }]);
  }

  // Build one root GROUP wrapper (multi-root only): a labeled section with a header (folder name +
  // Remove) and its own <ul role="group"> of treeitems. The header carries the group's accessible name
  // so AT announces which workspace folder these rows belong to.
  function buildGroup(group: ExplorerRootGroup): HTMLLIElement {
    const wrap = document.createElement('li');
    wrap.className = 'explorer-group';
    wrap.setAttribute('role', 'none'); // not a treeitem itself — a presentational section wrapper
    wrap.dataset.root = group.root;

    const header = document.createElement('div');
    header.className = 'explorer-group-header';

    const name = document.createElement('span');
    name.className = 'explorer-group-name';
    name.textContent = folderNameOf(group.root);
    header.appendChild(name);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'explorer-group-remove';
    remove.setAttribute('aria-label', `Remove folder ${name.textContent}`);
    remove.title = `Remove folder ${name.textContent}`;
    remove.textContent = '✕';
    remove.addEventListener('click', (ev) => {
      ev.stopPropagation();
      cb.onRemoveRoot?.(group.root);
    });
    header.appendChild(remove);

    const items = document.createElement('ul');
    items.className = 'explorer-group-items';
    items.setAttribute('role', 'group');
    items.setAttribute('aria-label', `Files in ${name.textContent}`);
    for (const entry of group.entries) {
      const li = buildItem(entry, 1, group.root);
      if (li) items.appendChild(li);
    }

    wrap.append(header, items);
    return wrap;
  }

  // Multi-root render: one GROUP per workspace root. Routes the single-root call through here too (as a
  // one-group list with no header), so there is a single render code path.
  function renderRoots(groups: ExplorerRootGroup[]): void {
    lastGroups = groups;
    rootToken = groups[0]?.root ?? '';
    rootTokens.clear();
    for (const g of groups) rootTokens.add(g.root);
    // Defer a re-render that lands during an inline rename/create, an open menu/confirm, or an active
    // drag — replaying it when the interaction ends — so we never detach a focused input (which would
    // commit a half-typed name on blur), dismiss a surface mid-aim, or invalidate a drag's drop checks.
    if (interactionOpen()) {
      pendingRender = { groups };
      return;
    }
    rendering = true;
    closeMenu();

    // The union of every group's entries, so one analyze() pass covers filter visibility, live dirs,
    // the match count and the active file across ALL roots.
    const allEntries = groups.flatMap((g) => g.entries);
    currentAnalysis = analyze(allEntries);

    // Drop stale tokens from `collapsed` (folders deleted/renamed/moved away since last render) so the
    // set can't grow unbounded or wrongly collapse a brand-new folder that reuses an old token.
    for (const t of [...collapsed]) {
      if (!currentAnalysis.liveDirs.has(t)) collapsed.delete(t);
    }

    // Auto-reveal the active file when it CHANGES: expand its ancestor folders (even ones the user
    // collapsed) and, after the rebuild, scroll its row into view. Not repeated for an unchanged
    // active file, so a diagnostics push doesn't fight the user re-collapsing a folder.
    let scrollActive = false;
    if (filterText) {
      // The filter drives visibility, so don't reveal now — but forget what we last revealed so that
      // clearing the filter re-reveals the active file (its ancestors may have been collapsed since).
      revealedActive = null;
    } else {
      const act = currentAnalysis.active;
      if (act && act.token !== revealedActive) {
        for (const t of act.ancestors) collapsed.delete(t);
        revealedActive = act.token;
        scrollActive = true;
      } else if (!act) {
        revealedActive = null;
      }
    }

    // If the user was navigating the tree by keyboard, remember which treeitem had focus (reading the
    // token off the focused element OR its nearest treeitem ancestor — e.g. the focused '⋯' button)
    // so we can restore it after the full rebuild instead of dropping focus to document.body.
    const active = document.activeElement as HTMLElement | null;
    const focusedItem = active && tree.contains(active) ? active.closest<HTMLElement>('li[role="treeitem"]') : null;
    const refocusToken = focusedItem?.dataset.token;

    tree.innerHTML = '';
    if (groups.length <= 1) {
      // Single root: NO group header — entries are direct treeitem children (byte-identical to the old
      // single-root render). Use the primary root token as the top-level New File/Folder parent.
      for (const entry of groups[0]?.entries ?? []) {
        const li = buildItem(entry, 1, rootToken);
        if (li) tree.appendChild(li);
      }
    } else {
      // Multiple roots: one labeled group section per root.
      for (const group of groups) tree.appendChild(buildGroup(group));
    }

    // Empty / no-match state.
    if (!tree.querySelector('li[role="treeitem"]')) {
      const empty = document.createElement('div');
      empty.className = 'explorer-empty';
      if (filterText) {
        empty.textContent = `No files match “${filterInput.value.trim()}”.`;
      } else {
        const line = document.createElement('p');
        line.className = 'explorer-empty-line';
        line.textContent = 'This folder is empty.';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'explorer-empty-action';
        btn.textContent = 'New file';
        btn.addEventListener('click', () => beginCreate(rootToken, 'file'));
        empty.append(line, btn);
      }
      tree.appendChild(empty);
    }

    // Filter-count chip.
    if (filterText) {
      const n = currentAnalysis.matchCount;
      filterCount.textContent = `${n} match${n === 1 ? '' : 'es'}`;
    } else {
      filterCount.textContent = '';
    }

    const restore = refocusToken
      ? tree.querySelector<HTMLElement>(`li[role="treeitem"][data-token="${cssEscape(refocusToken)}"]`)
      : null;
    if (restore) {
      restore.tabIndex = 0;
      restore.focus();
    } else {
      // Otherwise make the first treeitem the single tab stop.
      const first = tree.querySelector<HTMLElement>('li[role="treeitem"]');
      if (first) first.tabIndex = 0;
    }

    if (scrollActive) {
      const activeRow = tree.querySelector<HTMLElement>('.explorer-row[aria-current="true"]');
      activeRow?.scrollIntoView?.({ block: 'nearest' });
    }

    rendering = false;
    pendingRender = null;
  }

  // Replay a render that was deferred during a rename/create / open menu / confirm, once all clear.
  function flushPendingRender(): void {
    if (pendingRender && !interactionOpen() && !rendering) {
      const p = pendingRender;
      pendingRender = null;
      renderRoots(p.groups);
    }
  }

  // --- reveal by context ("Reveal in Files", #453) ----------------------------

  // Find the file backing a bounded context by matching its STEM (the basename minus the `.koi`
  // extension) case-insensitively — the convention that one `.koi` file is one bounded context. Returns
  // the file token + its ancestor directory tokens (to expand on the way), or null when none matches. The
  // explorer is token-opaque, so the lookup walks the structural FsEntry tree rather than parsing paths.
  function findFileForContext(context: string): { token: string; ancestors: string[] } | null {
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
    for (const g of lastGroups) for (const e of g.entries) walk(e, []);
    return hit;
  }

  function revealByContext(context: string): void {
    const found = findFileForContext(context);
    if (!found) return; // best-effort: no matching .koi → silent no-op
    // Expand every ancestor folder (even ones the user collapsed) so the target row is visible, then
    // rebuild the tree once with those folders open.
    for (const t of found.ancestors) collapsed.delete(t);
    renderRoots(lastGroups);
    // Highlight the freshly-rebuilt row (the prior tree was torn down, so query by token) and bring it
    // into view. Clear any earlier reveal mark first so only one row reads as revealed at a time.
    for (const r of tree.querySelectorAll('.explorer-row.is-revealed')) r.classList.remove('is-revealed');
    const row = tree.querySelector<HTMLElement>(
      `li[role="treeitem"][data-token="${cssEscape(found.token)}"] > .explorer-row`,
    );
    if (!row) return;
    row.classList.add('is-revealed');
    row.scrollIntoView?.({ block: 'nearest' });
  }

  return { el: root, render, renderRoots, revealByContext };
}

/** The folder name shown in a group header: the root token's last non-empty path segment. */
function folderNameOf(root: string): string {
  const segs = root.split(/[\\/]/).filter(Boolean);
  return segs.length ? segs[segs.length - 1] : root;
}

/** Escape a token for use inside a CSS attribute selector (CSS.escape when available). */
function cssEscape(value: string): string {
  const c = (globalThis as { CSS?: { escape?: (s: string) => string } }).CSS;
  return c?.escape ? c.escape(value) : value.replace(/["\\]/g, '\\$&');
}

// A .explorer-row carries its FsEntry and owning <li> so keyboard/menu code can recover them.
interface RowEl extends HTMLElement {
  _entry?: FsEntry;
  _li?: HTMLLIElement;
}

function toolbarButton(label: string, svg: string, onClick: () => void, extraClass?: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = extraClass ? `explorer-tool ${extraClass}` : 'explorer-tool';
  btn.setAttribute('aria-label', label);
  btn.title = label;
  // The icon is decorative — aria-hidden so screen readers announce only the aria-label, not the
  // SVG, and the button keeps its accessible name from aria-label.
  const icon = document.createElement('span');
  icon.className = 'explorer-tool-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.innerHTML = svg;
  btn.appendChild(icon);
  btn.addEventListener('click', onClick);
  return btn;
}
