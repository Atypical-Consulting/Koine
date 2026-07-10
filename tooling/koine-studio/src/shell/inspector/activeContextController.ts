// The bounded-context SCOPE switcher (#146) — extracted from inspectorController (Task 2 of #985's
// decomposition). Owns the single choke point for every scope change: the app store's `activeContext`
// slice itself (via a thin read/write handle), the per-workspace persist/restore, the status-bar
// "Context: X" readout sync, the model's context-list refresh (+ the docs-coverage ring it ships
// alongside, since both come off the same glossary-model fetch), and the active-file-follow behaviour
// (opening a `.koi` nudges the scope to that file's context).
//
// The store's `activeContext` slice is the single source of truth: this module subscribes to it so ANY
// writer — this controller's own `setActiveContext` choke point, OR a direct store write from elsewhere
// (the Domain navigator's drill, #453) — drives the status-bar sync and the scope fan-out identically.
// That's what fixed #531: before, a direct slice write skipped the two imperative side-effects that only
// the (then-inspectorController-local) `applyScope` ran, so the drill left the status bar and the canvas
// stale while the store already reflected the new scope.
//
// `rerenderScopedSurfaces` — the actual re-filter of the model-derived surfaces (the diagram, the Files
// tree, the bottom tables, the Output rail) — stays BEHIND an injected hook: its body (invalidate +
// loadModel/loadDiagrams/invalidateBottomPanels) still lives in inspectorController.tsx until Task 3
// rehomes those loaders into their own module. This module only ever CALLS the hook; it never
// reimplements or reaches for the loaders itself.
//
// Deliberately standalone: this module never imports `@/shell/inspectorController` (the facade wires it
// in, never the reverse — importing back would be a cycle) and never imports Task 1's
// `inspector/contextMapPanel.tsx` (sub-modules don't import each other — only the facade wires
// cross-module effects). The status-bar host (`#sb-context`) is injected, so this module never does its
// own DOM lookup — it mirrors contextMapPanel's `host` injection for the same reason.
import type { StoreApi } from 'zustand/vanilla';
import type { AppState } from '@/store/index';
import type { DocumentSymbol, GlossaryModel } from '@/lsp/lsp';
import { ALL_CONTEXTS, fileContextFollow, isAllContexts, listContexts, type ContextScope } from '@/model/activeContext';
import { coverage } from '@/model/glossary';
import { createLifecycleGuard } from '@/shared/lifecycleGuard';

// LSP SymbolKind for a namespace — the kind the language service tags each top-level `context` document
// symbol with. Used by followActiveFileContext to read a file's bounded context(s).
const SYMBOL_KIND_NAMESPACE = 3;

/**
 * The narrow LSP surface this controller needs: the glossary model (the context-list + doc-coverage
 * source) and the active file's document symbols (context-follow). A structural subset of
 * `InspectorControllerLsp`, defined locally (not imported) so this module never depends on the facade;
 * any object with matching methods (including the real `InspectorControllerLsp`) satisfies it.
 */
export interface ActiveContextControllerLsp {
  glossaryModel(): Promise<GlossaryModel>;
  documentSymbols(): Promise<DocumentSymbol[]>;
}

/** A thin read/write shim over the app store's `activeContext` slice (#146) — the store is the single
 *  source of truth; this is just a typed handle. The facade exposes this verbatim as
 *  `InspectorController.activeContext`, which ide.ts reads for the diagram add-type path. */
export interface ActiveContextHandle {
  get(): ContextScope;
  set(scope: ContextScope): void;
}

export interface ActiveContextControllerDeps {
  /** The app state store — the same instance the facade was constructed with. */
  store: StoreApi<AppState>;
  lsp: ActiveContextControllerLsp;
  /** The uri the editor currently shows (read live from ide.ts, forwarded by the facade). */
  activeUri(): string;
  /** The opened-folder token (or '' in no-folder mode) — keys the per-workspace scope persistence. */
  folderRootToken(): string;
  /** Persist/restore the active scope for a workspace key (ide.ts's storage seam, forwarded verbatim by
   *  the facade). */
  saveActiveContext(workspaceKey: string, scope: string): void;
  loadActiveContext(workspaceKey: string): string | null;
  /** The status-bar "Context" segment (`#sb-context`) this controller writes its readout into. Owned by
   *  the facade (which also wires the scope-picker MENU on the same node), injected here so this module
   *  never does its own DOM lookup. */
  statusBarEl: HTMLElement;
  /** The scope-change side effects that still live in the facade — Task 3 will rehome the loaders these
   *  invoke into their own module. Fired once per REAL `activeContext` slice change, from the store
   *  subscription this controller owns — never called directly by this module's own writers (they only
   *  ever write the slice; the subscription is the sole place the hook fires from). */
  hooks: {
    rerenderScopedSurfaces(): void;
  };
}

export interface ActiveContextController {
  /** The shared scope handle (#146) — the facade exposes this as `InspectorController.activeContext`. */
  readonly handle: ActiveContextHandle;
  /** A deliberate scope change (the status-bar picker, or any equivalent explicit pick) — persisted so a
   *  reload restores it. The SAME choke point a direct store write (e.g. the Domain-navigator drill)
   *  ultimately lands on via the subscription below, so both stay in lockstep (#531). */
  setActiveContext(scope: ContextScope): void;
  /** Refresh the switcher's context list from the workspace model (best-effort; empties on failure). */
  refreshContextList(): Promise<void>;
  /** Restore the persisted scope for the just-opened workspace, before the first scoped render. */
  restoreActiveContext(): void;
  /** Follow the active `.koi` file's bounded context (view-only — never persisted). */
  followActiveFileContext(): Promise<void>;
  /** The per-workspace storage key for the active scope (folder identity, or 'scratch'). */
  contextWorkspaceKey(): string;
  /** Drop the store subscription so a deferred scope change can't fire the hook into a torn-down host. */
  dispose(): void;
}

/** The human label for a scope: the context name, or "All contexts" for the unscoped sentinel. Exported
 *  so the facade's status-bar scope-picker MENU (which stays in inspectorController.tsx — only the
 *  choke point moved here) can label its rows identically without duplicating the mapping. */
export function scopeLabel(scope: ContextScope): string {
  return isAllContexts(scope) ? 'All contexts' : scope;
}

export function createActiveContextController(deps: ActiveContextControllerDeps): ActiveContextController {
  const { store, lsp, statusBarEl } = deps;

  // lifecycle.dispose() is called as dispose()'s first statement, mirroring the facade's own lifecycle
  // guard (#1002): suppresses a refreshContextList/followActiveFileContext continuation that resolves
  // after teardown from writing into a dead store.
  const lifecycle = createLifecycleGuard();

  // A thin handle over the app store's `activeContext` slice — the store is the single source of truth,
  // so writers set it here and every scoped surface (the diagram, the glossary, and the bottom
  // Events/Relationships tables) reads the same value back.
  const handle: ActiveContextHandle = {
    get: () => store.getState().activeContext,
    set: (scope) => store.getState().setActiveContext(scope),
  };

  /** The per-workspace storage key for the active scope (folder identity, or 'scratch'). */
  function contextWorkspaceKey(): string {
    return deps.folderRootToken() || 'scratch';
  }

  /** Mirror the active scope onto the status-bar readout. The top-bar selector reflects the scope on its
   *  own (the breadcrumb subscribes to the activeContext slice), so this only feeds the persistent
   *  status-bar "Context: X" — the readout that used to sit (redundantly) in the toolbar. */
  function syncContextStatusBar(): void {
    statusBarEl.textContent = `Context: ${scopeLabel(handle.get())}`;
  }

  // The single choke point for every scope change (the status-bar picker, a restored value's validation,
  // and the select-outside-scope path all route through here): update the store's `activeContext` slice,
  // optionally persist it for this workspace. The status-bar readout + the scoped-surface re-filter are
  // NOT driven here — the store subscription below owns them, firing on the slice write this performs.
  // That's what keeps EVERY writer of the slice in lockstep (#531): this choke point AND a direct store
  // write (e.g. the Domain navigator's drill, which calls the store's `setActiveContext` directly) both
  // land on the same subscription. `persist` is the user's intent flag — only a deliberate switcher
  // choice persists; non-deliberate changes (following a selection, or falling back off a vanished
  // context) are view-only so they never overwrite the user's last explicit choice in storage.
  function applyScope(scope: ContextScope, persist: boolean): void {
    handle.set(scope);
    if (persist) deps.saveActiveContext(contextWorkspaceKey(), scope);
  }

  /** A deliberate scope change (the status-bar picker) — persisted so a reload restores it. */
  function setActiveContext(scope: ContextScope): void {
    applyScope(scope, true);
  }

  // Adopt the current model's contexts as the scope options (the Domain navigator + construct palette
  // read them from the store). "All contexts" is the unscoped sentinel.
  function setContextOptions(list: string[]): void {
    store.getState().setContexts(list); // mirror into the store so the construct palette can react
    // Fall back to "All contexts" ONLY when we positively know the model's contexts (a non-empty list)
    // and the active scope isn't among them — a genuine rename/removal. An EMPTY list is a transient or
    // cold state (the LSP still warming up right after open, or a momentarily-unparseable model
    // mid-edit), so preserve the scope rather than clobber it. The fallback is view-only (not persisted),
    // so the user's last explicit choice survives in storage and a reload restores it once the context
    // is back.
    const scope = handle.get();
    if (list.length > 0 && !isAllContexts(scope) && !list.includes(scope)) {
      applyScope(ALL_CONTEXTS, false);
    } else {
      syncContextStatusBar();
    }
  }

  // Refresh the switcher's context list from the workspace model (best-effort; empties on failure). The
  // glossary model lists every declared type with its owning context, so it's the most complete source
  // for "every context that has anything in it".
  async function refreshContextList(): Promise<void> {
    try {
      const model = await lsp.glossaryModel();
      if (lifecycle.isDisposed()) return; // torn down mid-fetch (#1002/#1037) — no write into the dead host
      setContextOptions(listContexts(model));
      // Publish glossary documentation coverage for the status-bar docs ring (#923) — the model is
      // already in hand here, and this runs on folder open + every (debounced) edit, so the ring tracks
      // the live glossary. coverage() returns { documented, total, pct }; the ring needs the raw counts.
      const cov = coverage(model.entries);
      store.getState().setDocsCoverage({ documented: cov.documented, total: cov.total });
    } catch (e) {
      if (lifecycle.isDisposed()) return;
      // Best-effort: empty the picker, but log so a failing glossary model isn't a silent dead end.
      console.warn('Context list refresh failed; clearing the context picker.', e);
      setContextOptions([]);
      store.getState().setDocsCoverage({ documented: 0, total: 0 });
    }
  }

  // Restore the persisted scope for the just-opened workspace, before the first scoped render. The
  // control catches up when refreshContextList rebuilds the options (the slice value is what the render
  // paths read, so the initial render is already scoped regardless of the dropdown's paint timing).
  function restoreActiveContext(): void {
    const stored = deps.loadActiveContext(contextWorkspaceKey());
    const scope = stored && stored.length > 0 ? stored : ALL_CONTEXTS;
    // Set the store's scope so every scoped surface's first paint is already scoped.
    handle.set(scope);
    syncContextStatusBar();
  }

  // When the active .koi file changes, follow the bounded-context switcher to that file's context so the
  // top bar — and every scoped surface — reflects the file you're now editing. The file's primary
  // context is its first top-level document symbol. View-only (applyScope persist=false): navigating
  // between files shouldn't overwrite the user's deliberately chosen, persisted scope. A response for a
  // file the user has already switched away from is dropped; a file with no determinable context leaves
  // the scope untouched.
  async function followActiveFileContext(): Promise<void> {
    const uri = deps.activeUri();
    let contexts: string[];
    try {
      const symbols = await lsp.documentSymbols();
      // Top-level document symbols are the file's `context` declarations (SymbolKind 3 = Namespace).
      contexts = symbols.filter((s) => s.kind === SYMBOL_KIND_NAMESPACE).map((s) => s.name);
    } catch {
      return;
    }
    if (deps.activeUri() !== uri) return; // the user switched files while the symbols were in flight
    const next = fileContextFollow(contexts, handle.get());
    if (next !== undefined) applyScope(next, false);
  }

  // The store's `activeContext` slice is the single source of truth for the active scope: ANY writer —
  // this module's own choke point (applyScope) OR a direct store write from elsewhere (the Domain
  // navigator's drill, #453) — must drive the status-bar readout AND the scoped-surface re-filter hook.
  // Subscribing here (rather than running those two only inside applyScope) is what fixes #531: before,
  // a direct slice write skipped applyScope's two imperative side-effects, so the status bar stayed stale
  // while the store already reflected the new scope. Guarded on a real value change so an unrelated slice
  // write (setCenter / setSelection / …) is ignored — the store's own setActiveContext also no-ops on an
  // unchanged value, so this only fires once per genuine change; captured + unsubscribed on dispose so a
  // deferred change can't repaint a torn-down host.
  const unsubscribeActiveContext = store.subscribe((s, prev) => {
    if (s.activeContext === prev.activeContext) return;
    syncContextStatusBar();
    deps.hooks.rerenderScopedSurfaces();
  });

  function dispose(): void {
    lifecycle.dispose();
    unsubscribeActiveContext();
  }

  return {
    handle,
    setActiveContext,
    refreshContextList,
    restoreActiveContext,
    followActiveFileContext,
    contextWorkspaceKey,
    dispose,
  };
}
