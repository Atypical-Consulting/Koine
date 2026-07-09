// Workspace explorer facade (#989 task 8): mounts the keyed Preact `ExplorerPanel` tree instead of
// building the old `role=tree` DOM by hand. `createExplorer()` is now a THIN adapter between the
// host's imperative `Explorer` contract (below — unchanged since before #989) and `ExplorerPanel`'s
// props: it holds a tiny per-instance vanilla-zustand "props store" (`groups`/`reveal`/`activeContext`)
// that `render`/`renderRoots`/`revealByContext`/`setActiveContext` write into, mounts a small wrapper
// component that subscribes to it, and passes the chrome `store` (filter/collapsed state, #989 task 7)
// straight through. The whole imperative tree-build/diff/interaction-defer machinery this file used to
// own (`buildItem`/`buildGroup`, `wireDrag`/`wireInlineEdit`, `startRename`/`beginCreate`/
// `confirmDelete`, `openMenu`/`spawnMenu`, `interactionOpen`/`pendingRender`/`flushPendingRender`, the
// `RowEl` DOM expandos) is GONE — `ExplorerPanel`/`ExplorerItem`/`explorerModel.ts` (#989 tasks 1-7) own
// all of that now, tested directly against `ExplorerPanel.test.tsx`. This file (and its own
// `explorer.test.ts`, unchanged apart from one `beforeEach` store reset) is the parity gate: every
// scenario the old imperative widget passed still passes here, against the NEW facade-mounted panel.
//
// SYNC RENDERING: `explorer.test.ts` drives this facade the way the retired imperative widget always
// was — a raw `row.click()` / `input.dispatchEvent(...)` / `ex.render(...)` / `ex.revealByContext(...)`
// immediately followed by a DOM assertion, with no `act()` wrapper and no awaited tick. Preact defers a
// state-driven re-render by default, so making that observable synchronously needs patching Preact's
// internal scheduling seams — a test-environment concern, not a production one. That patch lives in
// `src/test-setup.ts` (vitest's `setupFiles`), NOT here: this file has zero Preact-internals patching.
import { render as preactRender } from 'preact';
import type { JSX } from 'preact';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { FsEntry } from '@/host';
import { appStore, type AppState } from '@/store/index';
import { ExplorerPanel } from '@/shell/ExplorerPanel';
import { findFileForContext } from '@/shell/explorerModel';

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
  /**
   * Emphasise the active bounded-context scope (ADR 0009 / #1188): the `.koi` file whose stem names
   * `context` is highlighted (a persistent accent marker) and the OTHER contexts' `.koi` files
   * de-emphasise — NEVER hidden, so every file op and the whole-tree overview survive. Folders and
   * non-`.koi` files stay neutral, and the active (open) file is never dimmed. Pass `null` (the *All
   * contexts* view) to clear the emphasis. The mapping is the one-`.koi`-per-context stem convention
   * {@link revealByContext} uses; a scope that names no file simply emphasises nothing — a no-op. The
   * emphasis is applied in the render pass, so it survives the diagnostics-driven tree rebuilds.
   */
  setActiveContext(context: string | null): void;
  /**
   * Teardown seam (#980). The explorer is a pre-Preact island with no owner-driven unmount, so nothing
   * released its deferred work between shell boots. dispose() clears the pending filter debounce (so a
   * queued `applyFilter → renderRoots` can't fire into a torn-down host), closes any open floating menu
   * (idempotent), and detaches `el`. Detaching `el` removes the persistent tree/filter-input listeners'
   * targets from the document — the tree-level dragover/dragleave/drop, the tree contextmenu, and the
   * filter input/keydown handlers all hang off nodes inside `el`; row-level listeners already die with
   * the innerHTML rebuilds.
   */
  dispose(): void;
}

/** The facade's per-instance props store shape — everything `createExplorer()`'s callers push in that
 *  `ExplorerPanel` can't derive from the (injected, possibly shared) chrome `store` alone. */
interface ExplorerProps {
  groups: ExplorerRootGroup[];
  /** Bumped (never merely re-set to the same value) by {@link Explorer.revealByContext} — see
   *  `ExplorerPanel`'s `reveal` prop doc for why `seq` exists (a repeat context must still re-trigger). */
  reveal: { context: string; seq: number } | null;
  activeContext: string | null;
}

interface ExplorerWrapperProps {
  cb: ExplorerCallbacks;
  propsStore: StoreApi<ExplorerProps>;
  chromeStore: StoreApi<AppState>;
}

/** Subscribes to the per-instance props store and renders `ExplorerPanel` off it, passing the chrome
 *  `store` straight through. Mounted ONCE per `createExplorer()` call; the props store's own updates
 *  drive every subsequent re-render (no re-mounting). */
function ExplorerWrapper({ cb, propsStore, chromeStore }: ExplorerWrapperProps): JSX.Element {
  const groups = useStore(propsStore, (s) => s.groups);
  const reveal = useStore(propsStore, (s) => s.reveal);
  const activeContext = useStore(propsStore, (s) => s.activeContext);
  return <ExplorerPanel cb={cb} groups={groups} reveal={reveal} activeContext={activeContext} store={chromeStore} />;
}

export function createExplorer(cb: ExplorerCallbacks, chromeStore: StoreApi<AppState> = appStore): Explorer {
  // The mount host. `display: contents` so it never becomes a layout box of its own — `ExplorerPanel`'s
  // own root `<div class="explorer">` stays the effective flex child of `.rail-sect-body`
  // (`_explorer.scss` relies on `.explorer` itself being the flex item, not a wrapper around it).
  const el = document.createElement('div');
  el.style.display = 'contents';

  const propsStore = createStore<ExplorerProps>(() => ({
    groups: [],
    reveal: null,
    activeContext: null,
  }));

  preactRender(<ExplorerWrapper cb={cb} propsStore={propsStore} chromeStore={chromeStore} />, el);

  // Multiple root groups, one GROUP per workspace root — see the Explorer.renderRoots JSDoc above.
  // ExplorerPanel derives the single-vs-multi-root header rendering from `groups.length` itself.
  function renderRoots(groups: ExplorerRootGroup[]): void {
    propsStore.setState({ groups });
  }

  // Single-root render: equivalent to renderRoots([{ root: rootToken, entries }]).
  function render(entries: FsEntry[], rootToken: string): void {
    renderRoots([{ root: rootToken, entries }]);
  }

  // Best-effort: resolve `context` to a `.koi` file BEFORE bumping `reveal`, so a miss is a genuinely
  // silent no-op (ExplorerPanel's reveal effect never even fires) — mirrors the retired imperative
  // `revealByContext`'s early `if (!found) return;`. `seq` always increments (never resets), so revealing
  // the SAME context twice in a row still re-triggers ExplorerPanel's reveal effect (a plain repeated
  // string wouldn't be a new value to react to).
  function revealByContext(context: string): void {
    const found = findFileForContext(propsStore.getState().groups, context);
    if (!found) return;
    const prevSeq = propsStore.getState().reveal?.seq ?? 0;
    propsStore.setState({ reveal: { context, seq: prevSeq + 1 } });
  }

  // Normalizes exactly like the retired imperative `setActiveContext` did: trim + lowercase, empty →
  // null; no-ops on an unchanged value so a fan-out that re-asserts the same scope doesn't force a
  // needless rebuild.
  function setActiveContext(context: string | null): void {
    const next = context && context.trim() ? context.trim().toLowerCase() : null;
    if (next === propsStore.getState().activeContext) return;
    propsStore.setState({ activeContext: next });
  }

  // Teardown seam (#980). Unmounting the Preact tree (render(null, el)) runs every ExplorerPanel
  // useEffect/useLayoutEffect cleanup — the filter debounce timer, the context-menu/confirm-modal mount
  // effect's own teardown (#989 task 4) — so a queued `applyFilter` (or any other pending effect) can
  // never fire into a torn-down host. That unmount also WIPES `el`'s rendered content, which is MORE
  // aggressive than the retired imperative `dispose()` (`root.remove()` alone — the tree's last-rendered
  // markup stayed intact, just detached; only its LISTENERS died, "since row-level listeners already die
  // with the innerHTML rebuilds" per this file's own long-standing dispose() contract). Snapshot the
  // rendered markup before unmounting and restore it after, so a caller that queries `el` post-dispose
  // (there is none in production, but `explorer.test.ts`'s own dispose() test does) still sees the frozen
  // last-rendered tree — inert, listener-free markup, exactly like the old contract — while every timer/
  // effect is still genuinely, unconditionally cleared. el.remove() then detaches the host.
  function dispose(): void {
    const frozen = el.innerHTML;
    preactRender(null, el);
    // Not an XSS sink: `frozen` is Preact's OWN already-rendered, already-escaped output captured from
    // this very element a moment ago — never attacker-controlled or unsanitized input — reinserted only
    // to preserve the frozen visual snapshot the old dispose() contract promised (see the comment above).
    // eslint-disable-next-line no-restricted-syntax -- trusted round-trip of this element's own markup, not user input
    el.innerHTML = frozen;
    el.remove();
  }

  return { el, render, renderRoots, revealByContext, setActiveContext, dispose };
}
