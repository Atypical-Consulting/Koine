import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ComponentChildren, JSX } from 'preact';
import type { FsEntry } from '@/host';
import type { ExplorerCallbacks, ExplorerRootGroup } from '@/shell/explorer';
import { analyze, flattenVisible, indexEntries, parentDirOf, parentMapOf } from '@/shell/explorerModel';
import { ExplorerItem } from '@/shell/ExplorerItem';
import { handleTreeKeydown, type RovingTreeNav } from '@/shell/rovingTreeNav';
import {
  createFloatingMenu,
  createModal,
  type FloatingMenu,
  type FloatingMenuItem,
  type ModalHandle,
} from '@atypical/koine-ui';

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
// KEYBOARD NAV (#989 task 3): one delegated `onKeyDown` on the shared `ul[role="tree"]` — see
// `onTreeKeyDown` below — routed through the SAME shared WAI-ARIA roving-tabindex router
// (`shell/rovingTreeNav.ts`'s `handleTreeKeydown`, #1105) that explorer.ts's old per-row `rowNav` used,
// so ArrowUp/Down/Left/Right and Enter behave identically to the pre-migration explorer. `focusedToken`
// is Preact state; `ExplorerItem`'s `tabIndex` is a pure function of it (`token === focusedToken`), not
// an imperative DOM sweep. There are NO per-row keydown listeners — a nested row's keydown simply bubbles
// to the one handler on `ul[role="tree"]`, which is what makes the old "double-fire through nested
// treeitem ancestors" bug (and its `stopPropagation` workaround) structurally impossible here.
//
// NOT in this task: drag-and-drop move, inline create/rename inputs, the "…" per-row context-menu
// trigger, and the ADR-0009 active-context is-scoped/dim emphasis (explorerModel.ts's public `analyze()`
// doesn't carry that scope match — only the private analyze() inside explorer.ts does). `filterText` and
// the collapsed-directories set are component-LOCAL `useState` here; task 7 lifts them into the app store.
//
// CONTEXT MENUS + DELETE CONFIRM (#989 task 4): right-click a row, the `ContextMenu` key on a focused
// row, or right-click the tree's empty background all open a `createFloatingMenu` (row: New File/New
// Folder/Rename/Duplicate/Delete; background: New File/New Folder only) — see `openRowMenu`/
// `openRootMenu` below. Delete (menu item OR the `Delete` key) runs `confirmDelete`, a `createModal`-based
// in-pane confirm. BOTH overlays are the SAME imperative `@atypical/koine-ui` primitives explorer.ts uses
// (`createFloatingMenu`/`createModal`), NOT reimplemented as JSX — they mount on `document.body`, built
// once per `ExplorerPanel` instance in the mount effect below and torn down on unmount, so a re-render can
// never touch (or need to defer for) them; there is no `interactionOpen()`/`pendingRender`/
// `flushPendingRender()` machinery here, unlike explorer.ts. New File/New Folder/Rename don't have an
// inline-edit UI yet (that's #989 task 5) — their menu items call `beginCreate`/`startRename`, which for
// now only record the routing target into `pendingEdit` (a deliberately minimal placeholder — see its
// doc comment) rather than opening any input.
// F2 is still recognized-but-stubbed pending #989 task 5.
export interface ExplorerPanelProps {
  cb: ExplorerCallbacks;
  groups: ExplorerRootGroup[];
  /** Seed the filter field (tests/stories only) — the field is otherwise local state. */
  initialFilterText?: string;
  /** Seed the collapsed-directories set (tests/stories only). */
  initialCollapsed?: readonly string[];
}

// See `pendingEdit`'s doc comment (inside ExplorerPanel) for why this exists and how temporary it is.
interface PendingEdit {
  kind: 'new-file' | 'new-folder' | 'rename';
  /** The New File/Folder parent dir token, or the renamed entry's own token. */
  target: string;
}

// The delete-confirm dialog's imperative handle — one `createModal()` instance reused across every
// delete (its title/message/OK-label are rewritten per call), mirroring explorer.ts's
// ensureConfirmModal()/confirmModal/confirmTitleEl/confirmMsgEl/confirmOkBtn/confirmResolve exactly,
// just bundled into one object instead of five module-scoped `let`s (there's one of these per
// `ExplorerPanel` instance, not one for the whole module). `.explorer-confirm-btn` /
// `.explorer-confirm-btn-danger` are preserved verbatim — explorer.test.ts's parity assertions and this
// panel's own tests both query them.
interface ConfirmHandle {
  modal: ModalHandle;
  titleEl: HTMLElement | null;
  msgEl: HTMLParagraphElement;
  okBtn: HTMLButtonElement;
  /** The in-flight `openConfirm()` caller's resolver, or `null` when no confirm is pending. */
  resolve: ((ok: boolean) => void) | null;
}

// Build the confirm-dialog chrome once atop the shared `createModal()` engine — same engine, same
// `.explorer-confirm-btn`/`.explorer-confirm-btn-danger` classes, same Cancel/OK wiring and dismissal
// semantics (Esc / backdrop / ✕ all resolve `false` via `onClose`) as explorer.ts's
// ensureConfirmModal()/settleConfirm()/resolveConfirm(). No `flushPendingRender()` call anywhere here —
// that machinery doesn't exist in this component (see the file-header note on why).
function buildConfirmHandle(): ConfirmHandle {
  const modal = createModal({ title: 'Confirm', ariaLabel: 'Confirm' });
  const titleEl = modal.backdrop.querySelector<HTMLElement>('.koi-modal-title');
  const msgEl = document.createElement('p');
  msgEl.className = 'explorer-confirm-msg';
  modal.body.appendChild(msgEl);

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'explorer-confirm-btn';
  cancelBtn.textContent = 'Cancel';
  const okBtn = document.createElement('button');
  okBtn.type = 'button';
  okBtn.className = 'explorer-confirm-btn explorer-confirm-btn-danger';
  modal.footer.append(cancelBtn, okBtn);

  const handle: ConfirmHandle = { modal, titleEl, msgEl, okBtn, resolve: null };
  const settle = (ok: boolean): void => {
    const resolve = handle.resolve;
    handle.resolve = null;
    resolve?.(ok);
  };
  cancelBtn.addEventListener('click', () => {
    settle(false);
    modal.close();
  });
  okBtn.addEventListener('click', () => {
    settle(true);
    modal.close();
  });
  // Esc / backdrop / ✕ all route through createModal's own dismissal paths → its onClose hook: resolve
  // false (a no-op if Cancel/OK already settled the promise, since `handle.resolve` is already null).
  modal.onClose(() => settle(false));
  // The danger action gets default focus on open (createModal itself focuses the ✕ close button), so a
  // reflexive Enter still lands on OK — matching explorer.ts's own confirmOkBtn?.focus() right after
  // modal.open(). Registered once here (rather than at every call site) so it always applies.
  modal.onOpen(() => okBtn.focus());
  return handle;
}

export function ExplorerPanel(props: ExplorerPanelProps): JSX.Element {
  const { cb, groups } = props;
  const [filterInput, setFilterInput] = useState(props.initialFilterText ?? '');
  const [filterText, setFilterText] = useState(() => (props.initialFilterText ?? '').trim().toLowerCase());
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set(props.initialCollapsed ?? []));
  // The lone WAI-ARIA roving tab stop's token (#989 task 3) — `null` until the tree has been focused at
  // least once, in which case the first visible row is the default tab stop (see `effectiveFocusedToken`).
  const [focusedToken, setFocusedToken] = useState<string | null>(null);
  const treeRef = useRef<HTMLUListElement>(null);

  // PLACEHOLDER routing target for New File/New Folder/Rename menu actions (#989 task 4). Task 5 owns the
  // real inline-edit design (an actual `<input>` + commit/cancel) and will replace or extend this — this
  // only exists so `beginCreate`/`startRename` have somewhere obvious to record WHAT they were asked to
  // act on (the New File/Folder parent dir token, or the renamed entry's own token), so ExplorerPanel's
  // own tests can assert a menu item routed to the right target without asserting any input renders (none
  // does yet). Exposed on the root `.explorer` element via `data-pending-edit` (`"<kind>:<target>"`)
  // purely for that test observability.
  const [pendingEdit, setPendingEdit] = useState<PendingEdit | null>(null);

  // Debounce the filter — 110ms, mirroring explorer.ts's `setTimeout(applyFilter, 110)` — so each
  // keystroke doesn't re-derive visibility/highlighting for the whole tree.
  useEffect(() => {
    const id = setTimeout(() => setFilterText(filterInput.trim().toLowerCase()), 110);
    return () => clearTimeout(id);
  }, [filterInput]);

  // The row/root context menu and the delete-confirm dialog (#989 task 4) — the SAME imperative
  // `createFloatingMenu`/`createModal` overlay primitives explorer.ts uses, not a JSX reimplementation.
  // Both mount on `document.body`, OUTSIDE this component's own tree, so a Preact re-render can never
  // touch (or need to defer for) them — hence no `interactionOpen()`/`pendingRender`/
  // `flushPendingRender()` plumbing here, unlike explorer.ts. Built once per `ExplorerPanel` instance in
  // this mount effect and torn down on unmount: the floating menu's own `close(false)` already removes
  // its DOM node, but `createModal`'s backdrop has no such teardown of its own (it only hides on close),
  // so the cleanup below removes it explicitly — otherwise a remounted panel (e.g. across tests, or a
  // Storybook control change) would leave a stale, empty `.koi-modal-backdrop` sitting in `document.body`
  // forever, and a later `document.querySelector('.explorer-confirm-btn-danger')` could resolve to the
  // WRONG (stale) instance's button instead of the live one.
  const ctxMenuRef = useRef<FloatingMenu | null>(null);
  const confirmRef = useRef<ConfirmHandle | null>(null);
  useEffect(() => {
    ctxMenuRef.current = createFloatingMenu({
      menuClass: 'explorer-menu',
      itemClass: 'explorer-menu-item',
      markTriggerExpanded: false,
      guardTriggerSubtree: false,
      refocusTriggerOnActivate: true,
    });
    confirmRef.current = buildConfirmHandle();
    return () => {
      ctxMenuRef.current?.close(false);
      ctxMenuRef.current = null;
      confirmRef.current?.modal.close();
      confirmRef.current?.modal.backdrop.remove();
      confirmRef.current = null;
    };
  }, []);

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

  // The ordered, flattened visible rows — the SAME data this render walks (via `analysis.visible` inside
  // `renderEntry`) to decide what to show, reused as-is for keyboard-nav ordering (`navTokens` below) so
  // the two can never drift apart. Also backs the empty/no-match state (`totalRows`).
  const flatRows = useMemo(() => flattenVisible(groups, collapsed, filterText), [groups, collapsed, filterText]);
  const totalRows = flatRows.length;
  const showEmpty = totalRows === 0;

  const toggleDir = (token: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(token)) next.delete(token);
      else next.add(token);
      return next;
    });
  };

  // --- keyboard navigation (#989 task 3) --------------------------------------------------------------
  // `navTokens` is `flatRows`' token order — the exact visible-row sequence ArrowUp/Down walk. `rowByToken`
  // resolves a token back to its kind (dir/file) for expand/collapse/activate; `parentMap` (from
  // `explorerModel.ts`'s `parentMapOf`, not a DOM walk) resolves ArrowLeft's ascend-to-parent target.
  const navTokens = useMemo(() => flatRows.map((r) => r.token), [flatRows]);
  const rowByToken = useMemo(() => new Map(flatRows.map((r) => [r.token, r] as const)), [flatRows]);
  const parentMap = useMemo(() => parentMapOf(groups), [groups]);
  const navTokenSet = useMemo(() => new Set(navTokens), [navTokens]);
  // The default tab stop: the currently roving-focused token when it's still visible, else the first
  // visible row (mirrors explorer.ts's renderRoots() falling back to `tree.querySelector('li[role=treeitem]')`
  // when there's no explicit refocus target) — keeps the tree Tab-reachable even before any key is pressed,
  // and recovers gracefully if the focused row was hidden by a collapse/filter change elsewhere.
  const effectiveFocusedToken = focusedToken != null && navTokenSet.has(focusedToken) ? focusedToken : (navTokens[0] ?? null);

  // Find a row's <li role="treeitem"> in the live DOM (not a CSS attribute-value selector, since a token
  // is an opaque path that could contain characters unsafe to interpolate into a selector string).
  const findRowEl = (token: string): HTMLLIElement | null => {
    const root = treeRef.current;
    if (!root) return null;
    for (const li of root.querySelectorAll<HTMLLIElement>('li[role="treeitem"][data-token]')) {
      if (li.dataset.token === token) return li;
    }
    return null;
  };

  // Move the roving tab stop to `token` AND move real browser focus there synchronously — like
  // explorer.ts's `focusItem()`, but the tabIndex flip itself is a derived render (via `focusedToken`),
  // not an imperative sweep. The target row is always already mounted: every token this is ever called
  // with comes from `navTokens` (already-visible rows) or is the SAME token whose subtree just expanded.
  const focusToken = (token: string | null): void => {
    setFocusedToken(token);
    if (token == null) return;
    findRowEl(token)?.focus();
  };

  // --- context menus + delete confirm (#989 task 4) ----------------------------------------------------
  // token → FsEntry + token → parentDir, for the keyboard-triggered (Delete key / ContextMenu key) paths
  // below — a right-click's own `renderEntry` closure already has both for free (see `parentDirOf` usage
  // there), but the roving-tabindex row order (`navTokens`/`rowByToken`) only carries a bare token.
  const entryIndex = useMemo(() => indexEntries(groups), [groups]);
  // The PRIMARY root token (the first group's): the root-menu New File/New Folder target, mirroring
  // explorer.ts's `rootToken` (always `groups[0]?.root` there too).
  const primaryRoot = groups[0]?.root ?? '';

  // New File/New Folder/Rename menu actions (#989 task 4): no inline-edit UI exists yet (#989 task 5), so
  // these only record the routing target `pendingEdit` carries — see its doc comment above.
  const beginCreate = (parentDirToken: string, kind: 'file' | 'dir'): void => {
    setPendingEdit({ kind: kind === 'dir' ? 'new-folder' : 'new-file', target: parentDirToken });
  };
  const startRename = (token: string): void => {
    setPendingEdit({ kind: 'rename', target: token });
  };

  // The shared confirm dialog (#989 task 4), ported from explorer.ts's openConfirm()/confirmDelete():
  // resolves true on the danger OK button, false on Cancel/Escape/backdrop-click (createModal's own
  // onClose hook covers all three dismissal paths uniformly via `buildConfirmHandle`'s wiring above).
  const openConfirm = (title: string, message: string, confirmLabel: string): Promise<boolean> => {
    const handle = confirmRef.current;
    if (!handle) return Promise.resolve(false);
    handle.resolve?.(false); // settle any stale promise defensively before reusing the dialog
    if (handle.titleEl) handle.titleEl.textContent = title;
    handle.msgEl.textContent = message;
    handle.okBtn.textContent = confirmLabel;
    return new Promise<boolean>((resolve) => {
      handle.resolve = resolve;
      handle.modal.open();
    });
  };
  const confirmDelete = async (entry: FsEntry): Promise<void> => {
    const what = entry.kind === 'dir' ? 'folder and everything in it' : 'file';
    const ok = await openConfirm(`Delete ${entry.name}?`, `This removes the ${what}. It can’t be undone.`, 'Delete');
    if (ok) cb.onDelete(entry);
  };

  // Open the row action menu for `entry` at viewport coords (x, y) — the New File/New Folder target is
  // `parentDirOf(entry, parentDir)`, where `parentDir` is `entry`'s own containing-directory token (the
  // owning group's root for a top-level entry), resolved via `entryIndex.parentDirs`.
  const openRowMenu = (entry: FsEntry, x: number, y: number): void => {
    const menu = ctxMenuRef.current;
    if (!menu) return;
    const parent = parentDirOf(entry, entryIndex.parentDirs.get(entry.token) ?? primaryRoot);
    const items: FloatingMenuItem[] = [
      { id: 'new-file', label: 'New File', run: () => beginCreate(parent, 'file') },
      { id: 'new-folder', label: 'New Folder', run: () => beginCreate(parent, 'dir') },
      { id: 'rename', label: 'Rename', run: () => startRename(entry.token) },
      { id: 'duplicate', label: 'Duplicate', run: () => cb.onDuplicate(entry) },
      { id: 'delete', label: 'Delete', run: () => void confirmDelete(entry) },
    ];
    menu.open({ trigger: document.activeElement as HTMLElement | null, at: { x, y }, items });
  };

  // Open the empty-space (background) menu at viewport coords (x, y), targeting the PRIMARY root —
  // mirrors explorer.ts's openRootMenu.
  const openRootMenu = (x: number, y: number): void => {
    const menu = ctxMenuRef.current;
    if (!menu) return;
    const items: FloatingMenuItem[] = [
      { id: 'new-file', label: 'New File', run: () => beginCreate(primaryRoot, 'file') },
      { id: 'new-folder', label: 'New Folder', run: () => beginCreate(primaryRoot, 'dir') },
    ];
    menu.open({ trigger: document.activeElement as HTMLElement | null, at: { x, y }, items });
  };

  // Delegated `contextmenu` fallback on the shared tree: fires ONLY for a right-click that lands outside
  // every row's own `.explorer-row` (i.e. the tree's empty background, or a multi-root group header) —
  // mirrors explorer.ts's tree-level `contextmenu` listener, which guards itself the same way so it never
  // double-opens a menu for a click a row's own `onContextMenu` (wired in ExplorerItem) already handled.
  const onTreeContextMenu = (ev: JSX.TargetedMouseEvent<HTMLUListElement>): void => {
    if ((ev.target as HTMLElement | null)?.closest('.explorer-row')) return;
    ev.preventDefault();
    openRootMenu(ev.clientX, ev.clientY);
  };

  // One delegated `onKeyDown` on the shared `ul[role="tree"]` (NOT one listener per row) — routes
  // ArrowUp/Down/Left/Right/Enter through the shared `handleTreeKeydown` router (rovingTreeNav.ts, #1105),
  // exactly as explorer.ts's old per-row `rowNav`/`onRowKeydown` did, minus the `stopPropagation()` that
  // router needed: with only ONE handler total, a nested row's keydown simply bubbles here once, so there
  // is nothing left to double-fire. `supportsHomeEnd`/`supportsSpaceActivate` stay `false` — this pane
  // deliberately never wired Home/End or Space-activation, matching explorer.ts's rowNav exactly.
  const onTreeKeyDown = (ev: JSX.TargetedKeyboardEvent<HTMLUListElement>): void => {
    if (navTokens.length === 0) return;
    const rowEl = (ev.target as HTMLElement | null)?.closest<HTMLElement>('li[role="treeitem"][data-token]') ?? null;
    const token = rowEl?.dataset.token ?? effectiveFocusedToken;
    const idx = token != null ? navTokens.indexOf(token) : -1;

    // Panel-specific keys the shared router doesn't own (matches explorer.ts's onRowKeydown switch).
    // F2 stays a stub pending #989 task 5 (no inline-rename UI exists yet); Delete/ContextMenu are wired
    // (#989 task 4) to the same confirmDelete/openRowMenu the row's right-click and menu items use.
    switch (ev.key) {
      case 'F2':
        ev.preventDefault();
        // TODO(#989 task 5): start inline rename for `token`.
        return;
      case 'Delete': {
        ev.preventDefault();
        const entry = token != null ? entryIndex.entries.get(token) : undefined;
        if (entry) void confirmDelete(entry);
        return;
      }
      case 'ContextMenu': {
        ev.preventDefault();
        const entry = token != null ? entryIndex.entries.get(token) : undefined;
        const li = token != null ? findRowEl(token) : null;
        if (entry && li) {
          const r = li.getBoundingClientRect();
          openRowMenu(entry, r.left, r.bottom);
        }
        return;
      }
    }

    const nav: RovingTreeNav<string> = {
      items: () => navTokens,
      activeIndex: () => idx,
      focusIndex: (i) => focusToken(navTokens[i] ?? null),
      // ArrowRight: open a closed directory in place (focus stays on it), or step into an already-open
      // one's next visible row. Always reports the key consumed — a file has nothing to expand.
      expand: (i) => {
        const t = navTokens[i];
        const row = rowByToken.get(t);
        if (row?.kind === 'dir') {
          const open = filtering || !collapsed.has(t);
          if (!open) {
            setCollapsed((prev) => {
              const next = new Set(prev);
              next.delete(t);
              return next;
            });
          } else if (i < navTokens.length - 1) {
            focusToken(navTokens[i + 1]);
          }
        }
        return true;
      },
      // ArrowLeft: collapse an open directory in place, else ascend to the parent row.
      collapse: (i) => {
        const t = navTokens[i];
        const row = rowByToken.get(t);
        const open = row?.kind === 'dir' && (filtering || !collapsed.has(t));
        if (open) {
          setCollapsed((prev) => {
            const next = new Set(prev);
            next.add(t);
            return next;
          });
        } else {
          const parent = parentMap.get(t) ?? null;
          if (parent != null) focusToken(parent);
        }
        return true;
      },
      // Enter: toggle a directory, or open a file.
      activate: (i) => {
        const t = navTokens[i];
        const row = rowByToken.get(t);
        if (row?.kind === 'dir') toggleDir(t);
        else cb.onOpenFile(t);
        return true;
      },
      supportsHomeEnd: false,
      supportsSpaceActivate: false,
    };
    handleTreeKeydown(nav, ev);
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
  //
  // The row's right-click New File/New Folder target (#989 task 4) is resolved via `openRowMenu` →
  // `entryIndex.parentDirs`, not threaded down through this recursion as an extra parameter — `entryIndex`
  // already carries the exact same `parentDir` explorer.ts's `buildItem(entry, level, parentDir)` threads,
  // for every entry, so there is no need for a second, redundant way to get there.
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
        focused={entry.token === effectiveFocusedToken}
        onToggle={() => toggleDir(entry.token)}
        onOpen={() => cb.onOpenFile(entry.token)}
        onContextMenu={(e) => {
          e.preventDefault();
          openRowMenu(entry, e.clientX, e.clientY);
        }}
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
    <div
      class="explorer"
      // See `pendingEdit`'s doc comment above — test-only observability for the New File/New
      // Folder/Rename menu stubs, not part of Task 5's eventual real inline-edit design.
      data-pending-edit={pendingEdit ? `${pendingEdit.kind}:${pendingEdit.target}` : undefined}
    >
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
        // requires (one delegated `onKeyDown` on `ul[role="tree"]`, so arrow-key nav can cross group
        // boundaries — see `onTreeKeyDown` above) and what explorer.test.ts's structural assertions pin (a
        // lone `ul[role="tree"]` queried singular throughout).
        <ul
          class="explorer-tree"
          role="tree"
          aria-label="Workspace files"
          ref={treeRef}
          onKeyDown={onTreeKeyDown}
          onContextMenu={onTreeContextMenu}
        >
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
