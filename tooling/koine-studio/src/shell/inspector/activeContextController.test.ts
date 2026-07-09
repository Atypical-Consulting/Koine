// Tests for the bounded-context SCOPE switcher (#146) — extracted from inspectorController (Task 2 of
// #985's decomposition). Behavior is pinned two ways: HERE (the controller's own contract, in isolation)
// and in inspectorController.test.ts's pre-existing "bounded-context scope" / "#531" / "status-bar
// Context segment" describe blocks (the facade's delegation to this module, unmodified by this
// extraction).
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  createActiveContextController,
  scopeLabel,
  type ActiveContextControllerDeps,
} from '@/shell/inspector/activeContextController';
import { createAppStore } from '@/store/index';
import { ALL_CONTEXTS } from '@/model/activeContext';
import type { DocumentSymbol, GlossaryEntry, GlossaryModel } from '@/lsp/lsp';

const ZERO_RANGE = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };

// A namespace-kind (3) document symbol — what a top-level `context` declaration surfaces as.
function namespaceSymbol(name: string): DocumentSymbol {
  return { name, kind: 3, range: ZERO_RANGE, selectionRange: ZERO_RANGE };
}

function glossaryFixture(contextName = 'Billing'): GlossaryModel {
  const entries: GlossaryEntry[] = [
    {
      id: contextName,
      name: contextName,
      kind: 'context',
      context: contextName,
      qualifiedName: contextName,
      doc: null,
      nameRange: { start: { line: 0, character: 8 }, end: { line: 0, character: 8 + contextName.length } },
    },
  ];
  return { entries };
}

function makeLsp() {
  return {
    glossaryModel: vi.fn(async (): Promise<GlossaryModel> => glossaryFixture()),
    documentSymbols: vi.fn(async (): Promise<DocumentSymbol[]> => []),
  };
}
type Lsp = ReturnType<typeof makeLsp>;

function makeStatusBarEl(): HTMLElement {
  const el = document.createElement('button');
  el.id = 'sb-context';
  document.body.appendChild(el);
  return el;
}

function makeDeps(lsp: Lsp, over: Partial<ActiveContextControllerDeps> = {}): ActiveContextControllerDeps {
  return {
    store: createAppStore(),
    lsp,
    activeUri: () => 'file:///work/model.koi',
    folderRootToken: () => '',
    saveActiveContext: vi.fn(),
    loadActiveContext: vi.fn(() => null),
    statusBarEl: makeStatusBarEl(),
    hooks: { rerenderScopedSurfaces: vi.fn() },
    ...over,
  };
}

/** Let queued microtask-chained promises settle (mirrors inspectorController.test.ts's flush). */
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('createActiveContextController — scopeLabel', () => {
  test('labels the unscoped sentinel "All contexts" and a real scope by its name', () => {
    expect(scopeLabel(ALL_CONTEXTS)).toBe('All contexts');
    expect(scopeLabel('Billing')).toBe('Billing');
  });
});

describe('createActiveContextController — persistence (deliberate vs view-only), (a)', () => {
  test('a deliberate setActiveContext persists via saveActiveContext, keyed by the workspace', () => {
    const deps = makeDeps(makeLsp());
    const ctl = createActiveContextController(deps);

    ctl.setActiveContext('Billing');

    expect(deps.store.getState().activeContext).toBe('Billing');
    expect(deps.saveActiveContext).toHaveBeenCalledWith('scratch', 'Billing');
    ctl.dispose();
  });

  test('followActiveFileContext (a view-only follow) changes the scope but does NOT persist', async () => {
    const lsp = makeLsp();
    lsp.documentSymbols.mockResolvedValue([namespaceSymbol('Billing')]);
    const deps = makeDeps(lsp);
    const ctl = createActiveContextController(deps);

    await ctl.followActiveFileContext();

    expect(deps.store.getState().activeContext).toBe('Billing');
    expect(deps.saveActiveContext).not.toHaveBeenCalled();
    ctl.dispose();
  });

  test('the vanished-context fallback (a refreshContextList that no longer lists the active scope) does NOT persist', async () => {
    const lsp = makeLsp();
    lsp.glossaryModel.mockResolvedValue(glossaryFixture('Shipping')); // 'Billing' is gone
    const deps = makeDeps(lsp);
    const ctl = createActiveContextController(deps);
    deps.store.getState().setActiveContext('Billing'); // drilled into a context that's about to vanish

    await ctl.refreshContextList();

    expect(deps.store.getState().activeContext).toBe(ALL_CONTEXTS);
    expect(deps.saveActiveContext).not.toHaveBeenCalled();
    ctl.dispose();
  });
});

describe('createActiveContextController — vanished-context fallback, (b)', () => {
  test('a non-empty context list without the active scope falls back to All contexts', async () => {
    const lsp = makeLsp();
    lsp.glossaryModel.mockResolvedValue(glossaryFixture('Shipping'));
    const deps = makeDeps(lsp);
    const ctl = createActiveContextController(deps);
    deps.store.getState().setActiveContext('Billing');

    await ctl.refreshContextList();

    expect(deps.store.getState().activeContext).toBe(ALL_CONTEXTS);
    ctl.dispose();
  });

  test('an EMPTY context list (transient/cold state) preserves the active scope rather than clobbering it', async () => {
    const lsp = makeLsp();
    lsp.glossaryModel.mockResolvedValue({ entries: [] }); // e.g. the LSP is still warming up
    const deps = makeDeps(lsp);
    const ctl = createActiveContextController(deps);
    deps.store.getState().setActiveContext('Billing');

    await ctl.refreshContextList();

    expect(deps.store.getState().activeContext).toBe('Billing'); // untouched
    ctl.dispose();
  });

  test('refreshContextList also mirrors the contexts into the store and publishes docs coverage', async () => {
    const lsp = makeLsp();
    lsp.glossaryModel.mockResolvedValue(glossaryFixture('Billing'));
    const deps = makeDeps(lsp);
    const ctl = createActiveContextController(deps);

    await ctl.refreshContextList();

    expect(deps.store.getState().contexts).toEqual(['Billing']);
    expect(deps.store.getState().docsCoverage).toEqual({ documented: 0, total: 1 });
    ctl.dispose();
  });

  test('a failing glossaryModel fetch clears the picker and zeroes docs coverage (best-effort)', async () => {
    const lsp = makeLsp();
    lsp.glossaryModel.mockRejectedValue(new Error('boom'));
    const deps = makeDeps(lsp);
    const ctl = createActiveContextController(deps);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await ctl.refreshContextList();

    expect(deps.store.getState().contexts).toEqual([]);
    expect(deps.store.getState().docsCoverage).toEqual({ documented: 0, total: 0 });
    ctl.dispose();
  });
});

describe('createActiveContextController — #531: any slice write syncs #sb-context + fires the hook once, (c)', () => {
  test("the controller's own setActiveContext (the dropdown/menu path) syncs the status bar and fires the hook exactly once per real change", () => {
    const deps = makeDeps(makeLsp());
    const ctl = createActiveContextController(deps);
    const hook = deps.hooks.rerenderScopedSurfaces as ReturnType<typeof vi.fn>;

    ctl.setActiveContext('Billing');

    expect(deps.statusBarEl.textContent).toBe('Context: Billing');
    expect(hook).toHaveBeenCalledTimes(1);

    // Re-picking the SAME scope is a no-op at the store (setActiveContext no-ops on an unchanged value),
    // so no second sync/fire.
    ctl.setActiveContext('Billing');
    expect(hook).toHaveBeenCalledTimes(1);
    ctl.dispose();
  });

  test('a DIRECT store write bypassing setActiveContext (the #531 Domain-navigator-drill shape) still syncs the status bar and fires the hook exactly once', () => {
    const deps = makeDeps(makeLsp());
    const ctl = createActiveContextController(deps);
    const hook = deps.hooks.rerenderScopedSurfaces as ReturnType<typeof vi.fn>;

    deps.store.getState().setActiveContext('Billing'); // NOT via ctl.setActiveContext

    expect(deps.statusBarEl.textContent).toBe('Context: Billing');
    expect(hook).toHaveBeenCalledTimes(1);
    expect(deps.saveActiveContext).not.toHaveBeenCalled(); // a direct write never persists
    ctl.dispose();
  });

  test('an unrelated store write (a different slice) does not sync the status bar or fire the hook', () => {
    const deps = makeDeps(makeLsp());
    const ctl = createActiveContextController(deps);
    const hook = deps.hooks.rerenderScopedSurfaces as ReturnType<typeof vi.fn>;
    deps.statusBarEl.textContent = 'sentinel';

    deps.store.getState().setContexts(['Billing', 'Shipping']); // unrelated slice write

    expect(hook).not.toHaveBeenCalled();
    expect(deps.statusBarEl.textContent).toBe('sentinel');
    ctl.dispose();
  });
});

describe('createActiveContextController — followActiveFileContext races, (d)', () => {
  test('drops a stale documentSymbols response when activeUri() changed mid-flight', async () => {
    const lsp = makeLsp();
    let resolveSymbols!: (v: DocumentSymbol[]) => void;
    lsp.documentSymbols.mockImplementation(
      () =>
        new Promise<DocumentSymbol[]>((resolve) => {
          resolveSymbols = resolve;
        }),
    );
    let uri = 'file:///a.koi';
    const deps = makeDeps(lsp, { activeUri: () => uri });
    const ctl = createActiveContextController(deps);

    const pending = ctl.followActiveFileContext();
    uri = 'file:///b.koi'; // the user switched files while the symbols request was in flight
    resolveSymbols([namespaceSymbol('Billing')]);
    await pending;
    await flush();

    expect(deps.store.getState().activeContext).toBe(ALL_CONTEXTS); // the stale response was dropped
    ctl.dispose();
  });

  test('a response for the still-active file DOES follow the scope', async () => {
    const lsp = makeLsp();
    lsp.documentSymbols.mockResolvedValue([namespaceSymbol('Billing')]);
    const deps = makeDeps(lsp);
    const ctl = createActiveContextController(deps);

    await ctl.followActiveFileContext();

    expect(deps.store.getState().activeContext).toBe('Billing');
    ctl.dispose();
  });

  test('a file with no determinable context leaves the scope untouched', async () => {
    const lsp = makeLsp();
    lsp.documentSymbols.mockResolvedValue([]); // no `context` declarations
    const deps = makeDeps(lsp);
    const ctl = createActiveContextController(deps);
    deps.store.getState().setActiveContext('Billing');

    await ctl.followActiveFileContext();

    expect(deps.store.getState().activeContext).toBe('Billing'); // untouched
    ctl.dispose();
  });
});

describe('createActiveContextController — dispose(), (e)', () => {
  test('unsubscribes: no hook fire and no status-bar sync for a slice write after dispose()', () => {
    const deps = makeDeps(makeLsp());
    const ctl = createActiveContextController(deps);
    const hook = deps.hooks.rerenderScopedSurfaces as ReturnType<typeof vi.fn>;

    ctl.dispose();
    deps.statusBarEl.textContent = 'sentinel';
    deps.store.getState().setActiveContext('Billing'); // a deferred/late write after teardown

    expect(hook).not.toHaveBeenCalled();
    expect(deps.statusBarEl.textContent).toBe('sentinel');
  });

  test('is safe to call before any scope change', () => {
    const ctl = createActiveContextController(makeDeps(makeLsp()));
    expect(() => ctl.dispose()).not.toThrow();
  });
});

describe('createActiveContextController — contextWorkspaceKey / restoreActiveContext', () => {
  test('contextWorkspaceKey falls back to "scratch" with no folder open, else the folder token', () => {
    const deps1 = makeDeps(makeLsp(), { folderRootToken: () => '' });
    expect(createActiveContextController(deps1).contextWorkspaceKey()).toBe('scratch');

    const deps2 = makeDeps(makeLsp(), { folderRootToken: () => '/repo/app' });
    expect(createActiveContextController(deps2).contextWorkspaceKey()).toBe('/repo/app');
  });

  test('restoreActiveContext restores a persisted scope and syncs the status bar', () => {
    const deps = makeDeps(makeLsp(), { loadActiveContext: vi.fn(() => 'Billing') });
    const ctl = createActiveContextController(deps);

    ctl.restoreActiveContext();

    expect(deps.loadActiveContext).toHaveBeenCalledWith('scratch');
    expect(deps.store.getState().activeContext).toBe('Billing');
    expect(deps.statusBarEl.textContent).toBe('Context: Billing');
    ctl.dispose();
  });

  test('restoreActiveContext defaults to All contexts when nothing was persisted', () => {
    const deps = makeDeps(makeLsp(), { loadActiveContext: vi.fn(() => null) });
    const ctl = createActiveContextController(deps);

    ctl.restoreActiveContext();

    expect(deps.store.getState().activeContext).toBe(ALL_CONTEXTS);
    expect(deps.statusBarEl.textContent).toBe('Context: All contexts');
    ctl.dispose();
  });
});
