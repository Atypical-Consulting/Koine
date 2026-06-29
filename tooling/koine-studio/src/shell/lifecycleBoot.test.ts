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
    importSharedWorkspace: vi.fn(async () => undefined),
    openWorkspaceWith1File: vi.fn(async () => undefined),
    openFolderPath: vi.fn(async () => ({ ok: true })),
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
  });

  it('restores the last OPFS-internal example workspace when there is no intent', async () => {
    getLastWorkspaceMock.mockReturnValue('example-billing');
    const deps = makeDeps();
    createLifecycleBoot(deps);
    await flush();
    expect(deps.openFolderPath).toHaveBeenCalledWith('example-billing', { recent: false });
    expect(deps.openHostDefaultWorkspaceFlow).not.toHaveBeenCalled(); // the restore succeeded
  });

  it('falls through to the default workspace (seeded) when nothing is restorable', async () => {
    getLastWorkspaceMock.mockReturnValue(null);
    const deps = makeDeps({ legacyScratch: null, seed: 'THE_SEED' });
    createLifecycleBoot(deps);
    await flush();
    expect(deps.openHostDefaultWorkspaceFlow).toHaveBeenCalledWith('THE_SEED');
  });

  it('teardown disposes every controller in the preserved order, then the route-intent sub', () => {
    const deps = makeDeps();
    const order = (deps as unknown as { _order: string[] })._order;
    const boot = createLifecycleBoot(deps);
    boot.teardown();
    expect(order).toEqual([
      'controller', 'editorSession', 'commandWiring', 'layout', 'overlays',
      'canvasWrite', 'panels', 'reviewStoreSub', 'autoSave', 'exportMenuDismiss',
    ]);
    expect(storeSubUnsub).toHaveBeenCalledOnce(); // unsubRouteIntent fired between autoSave and exportMenuDismiss
  });
});
