import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the module-level collaborators the boot ladder reaches (store subscription, emit targets, the
// one-shot start-intent, the hash/persistence helpers) so each branch is driven deterministically.
const { storeSubUnsub, takeStartIntentMock, getLastWorkspaceMock } = vi.hoisted(() => ({
  storeSubUnsub: vi.fn(),
  takeStartIntentMock: vi.fn(),
  getLastWorkspaceMock: vi.fn(),
}));
vi.mock('@/store/index', () => ({ appStore: { subscribe: vi.fn(() => storeSubUnsub) } }));
vi.mock('@/shared/emitTargets', () => ({ setEmitTargets: vi.fn() }));
vi.mock('@/shell/bootIntent', () => ({ takeStartIntent: takeStartIntentMock }));
vi.mock('@/export/share', () => ({ clearModelHash: vi.fn(), readModelFromHash: vi.fn() }));
vi.mock('@/settings/persistence', () => ({ getLastWorkspace: getLastWorkspaceMock, setLastWorkspace: vi.fn(), clearLegacyScratch: vi.fn() }));

import { createLifecycleBoot, type LifecycleBootDeps } from '@/shell/lifecycleBoot';
import { clearModelHash } from '@/export/share';
import { appStore } from '@/store/index';

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

function makeDeps(over: Partial<LifecycleBootDeps> = {}): LifecycleBootDeps {
  const order: string[] = [];
  const d = (name: string) => vi.fn(() => void order.push(name));
  return {
    lsp: {
      onServerRestart: vi.fn(),
      start: vi.fn(() => Promise.resolve()),
      emitTargets: vi.fn(() => Promise.resolve([])) as never,
    },
    shared: null,
    legacyScratch: null,
    seed: 'SEED',
    importSharedWorkspace: vi.fn(async () => true),
    openWorkspaceWith1File: vi.fn(async () => undefined),
    openFolderPath: vi.fn(async () => ({ ok: true })),
    // Default to the browser host's rule; desktop-path tests override this with their own predicate.
    isAutoRestorableToken: vi.fn(async (t: string) => t === '(default)' || t.startsWith('example-')),
    hasOpenWorkspace: vi.fn(() => false),
    confirmReplaceWork: vi.fn(async () => true),
    openHostDefaultWorkspaceFlow: vi.fn(async () => ({ opened: true })),
    setStatus: vi.fn(),
    setOutput: vi.fn(),
    invalidateDocViews: vi.fn(),
    refreshActiveSurfaces: vi.fn(),
    persistsWorkspace: true,
    showMemoryOnlyBanner: vi.fn(),
    newModel: vi.fn(async () => undefined),
    openFolder: vi.fn(async () => undefined),
    openRecentFolder: vi.fn(async () => undefined),
    openExample: vi.fn(async () => undefined),
    disposers: {
      controller: d('controller'),
      editorSession: d('editorSession'),
      commandWiring: d('commandWiring'),
      layout: d('layout'),
      overlays: d('overlays'),
      canvasWrite: d('canvasWrite'),
      panels: d('panels'),
      reviewStoreSub: d('reviewStoreSub'),
      autoSave: d('autoSave'),
      exportMenuDismiss: d('exportMenuDismiss'),
      editorKeys: d('editorKeys'),
      statusBar: d('statusBar'),
    },
    // expose the order array for the teardown test
    ...({ _order: order } as object),
    ...over,
  } as LifecycleBootDeps;
}

beforeEach(() => {
  vi.clearAllMocks();
  takeStartIntentMock.mockReturnValue(null);
  getLastWorkspaceMock.mockReturnValue(null);
});

describe('lifecycleBoot', () => {
  it('imports a shared WORKSPACE link once the server is up, then clears the hash', async () => {
    const deps = makeDeps({ shared: { kind: 'workspace', files: [{ relPath: 'a.koi', text: 'x' }], active: 'a.koi' } as never });
    createLifecycleBoot(deps);
    await flush();
    expect(deps.importSharedWorkspace).toHaveBeenCalledWith([{ relPath: 'a.koi', text: 'x' }], 'a.koi');
    expect(clearModelHash).toHaveBeenCalled();
  });

  it('opens a shared SINGLE model once the server is up', async () => {
    const deps = makeDeps({ shared: { kind: 'single', text: 'context X {}' } as never });
    createLifecycleBoot(deps);
    await flush();
    expect(deps.openWorkspaceWith1File).toHaveBeenCalledWith('context X {}');
  });

  it('performs a queued Home start-intent instead of opening the default workspace', async () => {
    takeStartIntentMock.mockReturnValue({ kind: 'new' });
    const deps = makeDeps();
    createLifecycleBoot(deps);
    await flush();
    expect(deps.newModel).toHaveBeenCalledOnce();
    expect(deps.openHostDefaultWorkspaceFlow).not.toHaveBeenCalled();
    // Cold boot: no unsaved work can exist yet, so the intent runs UNguarded (no confirm round-trip).
    expect(deps.confirmReplaceWork).not.toHaveBeenCalled();
  });

  // Regression: a workspace-share link whose import opens NOTHING (all relPaths filtered as unsafe, a
  // failed materialize, or a thrown import) used to leave the editor with zero buffers behind it —
  // every ⌘S was a silent no-op. The branch must fall through to the default workspace instead.
  it('falls through to the default workspace when a shared-workspace import opens nothing', async () => {
    const deps = makeDeps({
      shared: { kind: 'workspace', files: [{ relPath: '../escape.koi', text: 'x' }] } as never,
      importSharedWorkspace: vi.fn(async () => false),
      seed: 'THE_SEED',
    });
    createLifecycleBoot(deps);
    await flush();
    expect(clearModelHash).toHaveBeenCalled();
    expect(deps.openHostDefaultWorkspaceFlow).toHaveBeenCalledWith('THE_SEED');
  });

  it('falls through to the default workspace when the shared-workspace import throws', async () => {
    const deps = makeDeps({
      shared: { kind: 'workspace', files: [{ relPath: 'a.koi', text: 'x' }] } as never,
      importSharedWorkspace: vi.fn(async () => Promise.reject(new Error('materialize failed'))),
      seed: 'THE_SEED',
    });
    createLifecycleBoot(deps);
    await flush();
    expect(deps.setStatus).toHaveBeenCalledWith('could not open shared workspace', 'error');
    expect(deps.openHostDefaultWorkspaceFlow).toHaveBeenCalledWith('THE_SEED');
  });

  it('does NOT open the default after a shared-workspace import that succeeded', async () => {
    const deps = makeDeps({ shared: { kind: 'workspace', files: [{ relPath: 'a.koi', text: 'x' }] } as never });
    createLifecycleBoot(deps);
    await flush();
    expect(deps.openHostDefaultWorkspaceFlow).not.toHaveBeenCalled();
  });

  it('restores the last OPFS-internal example workspace when there is no intent', async () => {
    getLastWorkspaceMock.mockReturnValue('example-billing');
    const deps = makeDeps();
    createLifecycleBoot(deps);
    await flush();
    expect(deps.openFolderPath).toHaveBeenCalledWith('example-billing', { recent: false });
    expect(deps.openHostDefaultWorkspaceFlow).not.toHaveBeenCalled(); // the restore succeeded
  });

  // Regression: a desktop template token is an absolute `<appData>/workspaces/<id>` path, NOT a browser
  // `example-*` slug. The ladder must restore it via the HOST capability (not a hardcoded slug test);
  // before the fix this token matched nothing and every reload reverted to the blank default workspace.
  it('restores any token the host vouches for (e.g. a desktop <appData>/workspaces path)', async () => {
    const token = '/Users/x/Library/Application Support/com.atypical.koine-studio/workspaces/pizzeria';
    getLastWorkspaceMock.mockReturnValue(token);
    // The desktop host says any path under its materialized workspaces dir is auto-restorable.
    const deps = makeDeps({ isAutoRestorableToken: vi.fn(async (t: string) => t.includes('/workspaces/')) });
    createLifecycleBoot(deps);
    await flush();
    expect(deps.isAutoRestorableToken).toHaveBeenCalledWith(token);
    expect(deps.openFolderPath).toHaveBeenCalledWith(token, { recent: false });
    expect(deps.openHostDefaultWorkspaceFlow).not.toHaveBeenCalled();
  });

  // The complement: a token the host declines (a picked external folder, or any non-internal token)
  // is NOT auto-opened — the ladder falls through to the seeded default workspace.
  it('falls through to the default when the host declines the token (e.g. a picked folder)', async () => {
    getLastWorkspaceMock.mockReturnValue('/Users/x/some/picked/project');
    const deps = makeDeps({ isAutoRestorableToken: vi.fn(async () => false), seed: 'THE_SEED' });
    createLifecycleBoot(deps);
    await flush();
    expect(deps.openFolderPath).not.toHaveBeenCalled();
    expect(deps.openHostDefaultWorkspaceFlow).toHaveBeenCalledWith('THE_SEED');
  });

  it('falls through to the default workspace (seeded) when nothing is restorable', async () => {
    getLastWorkspaceMock.mockReturnValue(null);
    const deps = makeDeps({ legacyScratch: null, seed: 'THE_SEED' });
    createLifecycleBoot(deps);
    await flush();
    expect(deps.openHostDefaultWorkspaceFlow).toHaveBeenCalledWith('THE_SEED');
  });

  // Regression: the intent-less restore ladder runs only after lsp.start() resolves — a multi-second
  // window in the browser during which the user can already open a real folder. That workspace must
  // not be torn down and replaced by the restored/default one.
  it('skips the restore/default ladder entirely when a workspace was opened while connecting', async () => {
    getLastWorkspaceMock.mockReturnValue('/Users/x/some/picked/project');
    const deps = makeDeps({ hasOpenWorkspace: vi.fn(() => true) });
    createLifecycleBoot(deps);
    await flush();
    expect(deps.openFolderPath).not.toHaveBeenCalled();
    expect(deps.openHostDefaultWorkspaceFlow).not.toHaveBeenCalled();
  });

  // Regression: a RETURN visit to Home reaches the route-intent subscription with the IDE still alive
  // (dirty buffers can exist), but the intent used to run the RAW unguarded actions — "New model" from
  // Home silently wiped unsaved work (and the default workspace on disk) with no confirmation.
  describe('route-intent subscription (return visits)', () => {
    // The store is mocked, so drive the subscription callback lifecycleBoot registered directly.
    function routeCallback(): (s: { route: string }, prev: { route: string }) => void {
      const sub = vi.mocked((appStore as unknown as { subscribe: ReturnType<typeof vi.fn> }).subscribe);
      return sub.mock.calls[sub.mock.calls.length - 1][0];
    }

    it('asks confirmReplaceWork before running a destructive return-visit intent', async () => {
      const deps = makeDeps({ confirmReplaceWork: vi.fn(async () => false) });
      createLifecycleBoot(deps);
      await flush(); // let the (intent-less) boot ladder settle first

      takeStartIntentMock.mockReturnValue({ kind: 'new' });
      routeCallback()({ route: 'editor' }, { route: 'home' });
      await flush();

      expect(deps.confirmReplaceWork).toHaveBeenCalled();
      // The user declined — no reset, no workspace swap.
      expect(deps.newModel).not.toHaveBeenCalled();
    });

    it('runs the return-visit intent once the user confirms (or nothing is dirty)', async () => {
      const deps = makeDeps(); // confirmReplaceWork resolves true (nothing dirty / confirmed)
      createLifecycleBoot(deps);
      await flush();

      takeStartIntentMock.mockReturnValue({ kind: 'open-recent', path: '/proj' });
      routeCallback()({ route: 'editor' }, { route: 'home' });
      await flush();

      expect(deps.confirmReplaceWork).toHaveBeenCalled();
      expect(deps.openRecentFolder).toHaveBeenCalledWith('/proj');
    });

    // Regression (desktop "Model request failed: LSP not started"): on a Home-first cold boot the IDE is
    // lazy-initialised INSIDE main.ts's route→editor `set()` notification, and Set.forEach visits the
    // freshly-registered route-intent listener during that same transition. If it consumed the intent
    // there it would run the model-index request UNGATED, before lsp.start() resolves — which on desktop
    // (a dotnet sidecar that's seconds from answering `initialize`) deterministically hits "LSP not
    // started". The listener must ignore the boot transition and leave the intent to the gated boot ladder.
    it('does NOT consume the start-intent on the cold-boot transition (Set.forEach mid-iteration fire)', async () => {
      takeStartIntentMock.mockReturnValue({ kind: 'open-example', template: { id: 'billing' } as never });
      const deps = makeDeps();
      createLifecycleBoot(deps);

      // Simulate the boot transition firing the listener synchronously, BEFORE the boot notification has
      // drained (no `await flush()` yet) — i.e. still inside the same task, exactly as Set.forEach does.
      routeCallback()({ route: 'editor' }, { route: 'home' });
      expect(takeStartIntentMock).not.toHaveBeenCalled(); // the subscription stood down during boot
      expect(deps.openExample).not.toHaveBeenCalled();

      // The gated boot ladder (lsp.start().then(...)) is the sole consumer: it runs the intent exactly
      // once, after the server is up.
      await flush();
      expect(deps.openExample).toHaveBeenCalledOnce();
      expect(deps.openExample).toHaveBeenCalledWith({ id: 'billing' });
    });
  });

  it('teardown disposes every controller in the preserved order, then the route-intent sub', () => {
    const deps = makeDeps();
    const order = (deps as unknown as { _order: string[] })._order;
    const boot = createLifecycleBoot(deps);
    boot.teardown();
    expect(order).toEqual([
      'controller', 'editorSession', 'commandWiring', 'layout', 'overlays',
      'canvasWrite', 'panels', 'reviewStoreSub', 'autoSave', 'exportMenuDismiss', 'editorKeys',
      'statusBar',
    ]);
    expect(storeSubUnsub).toHaveBeenCalledOnce(); // unsubRouteIntent fired between autoSave and exportMenuDismiss
  });
});
