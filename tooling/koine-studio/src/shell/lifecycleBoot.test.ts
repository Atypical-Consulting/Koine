import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the module-level collaborators the boot ladder reaches (store subscription, emit targets, the
// one-shot start-intent, the hash/persistence helpers) so each branch is driven deterministically.
const { storeSubUnsub, takeStartIntentMock, peekStartIntentMock, getLastWorkspaceMock } = vi.hoisted(() => ({
  storeSubUnsub: vi.fn(),
  takeStartIntentMock: vi.fn(),
  peekStartIntentMock: vi.fn(),
  getLastWorkspaceMock: vi.fn(),
}));
vi.mock('@/store/index', () => ({ appStore: { subscribe: vi.fn(() => storeSubUnsub) } }));
vi.mock('@/shared/emitTargets', () => ({ setEmitTargets: vi.fn() }));
vi.mock('@/shell/bootIntent', () => ({ takeStartIntent: takeStartIntentMock, peekStartIntent: peekStartIntentMock }));
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
      workspaceSeams: d('workspaceSeams'),
      autoSave: d('autoSave'),
      exportMenuDismiss: d('exportMenuDismiss'),
      editorKeys: d('editorKeys'),
      statusBar: d('statusBar'),
      explorer: d('explorer'),
    },
    // expose the order array for the teardown test
    ...({ _order: order } as object),
    ...over,
  } as LifecycleBootDeps;
}

beforeEach(() => {
  vi.clearAllMocks();
  takeStartIntentMock.mockReturnValue(null);
  peekStartIntentMock.mockReturnValue(null);
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

  // Regression (#973): a boot-time lsp.start() rejection used to show only a generic "connection
  // failed" — never naming the template/folder the user picked on Home, and never letting them recover.
  describe('boot rejection with a queued Home intent (#973)', () => {
    function makeRejectingDeps(over: Partial<LifecycleBootDeps> = {}): LifecycleBootDeps {
      return makeDeps({
        lsp: {
          onServerRestart: vi.fn(),
          start: vi.fn(() => Promise.reject(new Error('spawn ENOENT'))),
          emitTargets: vi.fn(() => Promise.resolve([])) as never,
        },
        ...over,
      });
    }

    it('names the queued start action in the failure status/output instead of a generic message', async () => {
      peekStartIntentMock.mockReturnValue({ kind: 'open-example', template: { id: 'billing', name: 'Billing' } as never });
      const deps = makeRejectingDeps();
      createLifecycleBoot(deps);
      await flush();

      expect(deps.setStatus).toHaveBeenCalledWith(expect.stringContaining('Billing'), 'error');
      expect(deps.setOutput).toHaveBeenCalledWith(expect.stringContaining('Billing'), 'plain');
      // Peek must not consume it — Task 3's recovery re-dispatch still needs it.
      expect(takeStartIntentMock).not.toHaveBeenCalled();
    });

    it('keeps the generic "connection failed" message when there is no pending intent', async () => {
      peekStartIntentMock.mockReturnValue(null);
      const deps = makeRejectingDeps();
      createLifecycleBoot(deps);
      await flush();

      expect(deps.setStatus).toHaveBeenCalledWith('connection failed', 'error');
      expect(deps.setOutput).toHaveBeenCalledWith(expect.stringContaining('failed to start language server'), 'plain');
    });
  });

  // Regression (#973): onServerRestart used to only refresh views — a stranded Home intent (template,
  // folder, "New") never re-ran once the sidecar recovered, leaving the user on an empty workspace.
  describe('recovery re-dispatch after a failed boot (#973)', () => {
    function restartCallback(deps: LifecycleBootDeps): () => void {
      const fn = deps.lsp.onServerRestart as unknown as ReturnType<typeof vi.fn>;
      return fn.mock.calls[0][0];
    }

    function makeRejectingDeps(over: Partial<LifecycleBootDeps> = {}): LifecycleBootDeps {
      return makeDeps({
        lsp: {
          onServerRestart: vi.fn(),
          start: vi.fn(() => Promise.reject(new Error('spawn ENOENT'))),
          emitTargets: vi.fn(() => Promise.resolve([])) as never,
        },
        ...over,
      });
    }

    it('re-dispatches the retained intent exactly once when the server recovers', async () => {
      const billing = { id: 'billing', name: 'Billing' } as never;
      peekStartIntentMock.mockReturnValue({ kind: 'open-example', template: billing });
      const deps = makeRejectingDeps();
      createLifecycleBoot(deps);
      await flush(); // boot fails; bootIntentPending is now true

      takeStartIntentMock.mockReturnValue({ kind: 'open-example', template: billing });
      restartCallback(deps)();
      await flush();

      expect(deps.openExample).toHaveBeenCalledOnce();
      expect(deps.openExample).toHaveBeenCalledWith(billing);
    });

    it('does not replay on a second restart, and a normal restart only refreshes views', async () => {
      const billing = { id: 'billing', name: 'Billing' } as never;
      peekStartIntentMock.mockReturnValue({ kind: 'open-example', template: billing });
      const deps = makeRejectingDeps();
      createLifecycleBoot(deps);
      await flush();

      takeStartIntentMock.mockReturnValue({ kind: 'open-example', template: billing });
      const restart = restartCallback(deps);
      restart();
      await flush();
      expect(deps.openExample).toHaveBeenCalledOnce();

      restart(); // second restart: bootIntentPending is now false — no replay
      await flush();
      expect(deps.openExample).toHaveBeenCalledOnce();
      expect(deps.invalidateDocViews).toHaveBeenCalled();
      expect(deps.refreshActiveSurfaces).toHaveBeenCalled();
    });

    it('a normal mid-session restart (no failed boot) only refreshes views, never opens anything', async () => {
      const deps = makeDeps(); // lsp.start() resolves — bootIntentPending never set
      createLifecycleBoot(deps);
      await flush();

      restartCallback(deps)();
      await flush();

      expect(deps.openExample).not.toHaveBeenCalled();
      expect(deps.newModel).not.toHaveBeenCalled();
      expect(deps.invalidateDocViews).toHaveBeenCalled();
      expect(deps.refreshActiveSurfaces).toHaveBeenCalled();
    });

    it('the re-dispatch is guarded: confirmReplaceWork is consulted (matching the return-visit path)', async () => {
      const billing = { id: 'billing', name: 'Billing' } as never;
      peekStartIntentMock.mockReturnValue({ kind: 'open-example', template: billing });
      const confirmReplaceWork = vi.fn(async () => true);
      const deps = makeRejectingDeps({ confirmReplaceWork });
      createLifecycleBoot(deps);
      await flush();

      takeStartIntentMock.mockReturnValue({ kind: 'open-example', template: billing });
      restartCallback(deps)();
      await flush();

      expect(confirmReplaceWork).toHaveBeenCalled();
      expect(deps.openExample).toHaveBeenCalledWith(billing);
    });
  });

  it('teardown disposes every controller in the preserved order, then the route-intent sub', () => {
    const deps = makeDeps();
    const order = (deps as unknown as { _order: string[] })._order;
    const boot = createLifecycleBoot(deps);
    boot.teardown();
    expect(order).toEqual([
      'controller', 'editorSession', 'commandWiring', 'layout', 'overlays',
      'canvasWrite', 'panels', 'reviewStoreSub', 'workspaceSeams', 'autoSave', 'exportMenuDismiss', 'editorKeys',
      'statusBar', 'explorer',
    ]);
    expect(storeSubUnsub).toHaveBeenCalledOnce(); // unsubRouteIntent fired between autoSave and exportMenuDismiss
  });
});
