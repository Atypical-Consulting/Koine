// Issue #357: a failed worker boot must NOT brick the studio. loadWasmApi() falls back to a
// main-thread boot when the worker boot rejects (boot-failure OR timeout), and getWasmBootMode()
// reports which path won. Happy-dom has no real Worker and no real .NET runtime, so we mock the
// worker client and inject a fake dotnet module loader (the __setDotnetModuleLoaderForTests seam).
import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';
import { HOST_DECLARED_EXPORTS } from '@/host/browser/wasm';

vi.mock('@/host/browser/workerClient', () => ({ createKoineWorkerClient: vi.fn() }));

// A faithful Capabilities() payload (issue #330): the boot path verifies the surface against it. Reporting
// the full expected surface keeps these boot-mode tests on the happy path (no staleness warning).
const CAPABILITIES_JSON = JSON.stringify({
  version: '9.9.9-test',
  exports: [...HOST_DECLARED_EXPORTS],
  targets: [],
});

/** A fake dotnet ES module *value* whose CompilerInterop exposes the given methods. */
function dotnetModuleValue(interop: Record<string, unknown>) {
  return {
    dotnet: {
      create: async () => ({
        getConfig: () => ({ mainAssemblyName: 'Koine.Wasm.dll' }),
        // Inject a faithful Capabilities() (#330) so the boot-time surface check passes; a test can
        // override it by including its own Capabilities in `interop`.
        getAssemblyExports: async () => ({
          Koine: { Wasm: { CompilerInterop: { Capabilities: () => CAPABILITIES_JSON, ...interop } } },
        }),
      }),
    },
  };
}

/** A fake dotnet module *loader* (url → module), matching the DotnetModuleLoader / EsModuleImporter seam. */
function fakeDotnetModule(interop: Record<string, unknown>) {
  return async () => dotnetModuleValue(interop);
}

describe('loadWasmApi — main-thread fallback (issue #357)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  // Guard against an env stub (vi.stubEnv('DEV', …)) or fake-timer install leaking into a sibling test
  // if an assertion throws before the in-test restore runs — the dev-case tests rely on vitest's default
  // DEV===true, and the boot-timeout tests (issue #625) install fake timers.
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  test('falls back to a main-thread boot when the worker boot rejects (timeout)', async () => {
    const dispose = vi.fn();
    const { createKoineWorkerClient } = await import('@/host/browser/workerClient');
    (createKoineWorkerClient as ReturnType<typeof vi.fn>).mockReturnValue({
      call: vi.fn(),
      whenReady: vi.fn<() => Promise<void>>().mockRejectedValue(new Error('Koine worker timed out after 30s')),
      dispose,
    });

    const wasm = await import('@/host/browser/wasm');
    const listEmitTargets = vi.fn(() => '{"targets":[{"id":"csharp"}]}');
    wasm.__setDotnetModuleLoaderForTests(fakeDotnetModule({ ListEmitTargets: listEmitTargets }));

    const api = await wasm.loadWasmApi();

    expect(wasm.getWasmBootMode()).toBe('main-thread');
    expect(await api.ListEmitTargets()).toBe('{"targets":[{"id":"csharp"}]}');
    expect(dispose).toHaveBeenCalledOnce(); // the dead worker is torn down
  });

  test('exposes the GbnfGrammar surface — a call round-trips the bundle export (issue #257)', async () => {
    const { createKoineWorkerClient } = await import('@/host/browser/workerClient');
    (createKoineWorkerClient as ReturnType<typeof vi.fn>).mockReturnValue({
      call: vi.fn(),
      whenReady: vi.fn<() => Promise<void>>().mockRejectedValue(new Error('worker boot failed')),
      dispose: vi.fn(),
    });

    const wasm = await import('@/host/browser/wasm');
    const grammar = 'root ::= context+\ncontext ::= "context"';
    const gbnfGrammar = vi.fn(() => grammar);
    wasm.__setDotnetModuleLoaderForTests(fakeDotnetModule({ GbnfGrammar: gbnfGrammar }));

    const api = await wasm.loadWasmApi();

    expect(wasm.getWasmBootMode()).toBe('main-thread');
    expect(await api.GbnfGrammar()).toBe(grammar);
    expect(gbnfGrammar).toHaveBeenCalledOnce();
  });

  test('falls back to a main-thread boot when the worker posts an explicit boot-failure', async () => {
    const { createKoineWorkerClient } = await import('@/host/browser/workerClient');
    (createKoineWorkerClient as ReturnType<typeof vi.fn>).mockReturnValue({
      call: vi.fn(),
      whenReady: vi
        .fn<() => Promise<void>>()
        .mockRejectedValue(new Error('Koine WASM runtime did not finish booting within 20s')),
      dispose: vi.fn(),
    });

    const wasm = await import('@/host/browser/wasm');
    wasm.__setDotnetModuleLoaderForTests(fakeDotnetModule({ Glossary: () => '{"markdown":"ok"}' }));

    const api = await wasm.loadWasmApi();

    expect(wasm.getWasmBootMode()).toBe('main-thread');
    expect(await api.Glossary('[]')).toBe('{"markdown":"ok"}');
  });

  test('a TOTAL boot failure (worker AND main-thread) is not cached — a later call retries from scratch', async () => {
    const { createKoineWorkerClient } = await import('@/host/browser/workerClient');
    (createKoineWorkerClient as ReturnType<typeof vi.fn>).mockReturnValue({
      call: vi.fn(),
      whenReady: vi.fn<() => Promise<void>>().mockRejectedValue(new Error('worker boot failed')),
      dispose: vi.fn(),
    });

    const wasm = await import('@/host/browser/wasm');
    let attempt = 0;
    wasm.__setDotnetModuleLoaderForTests(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('dotnet.js 404 (transient)'); // first boot: main-thread also fails
      return fakeDotnetModule({ ListEmitTargets: () => '{"targets":[]}' })();
    });

    // First call: worker rejects AND main-thread rejects → total failure, propagated to the caller.
    await expect(wasm.loadWasmApi()).rejects.toThrow(/dotnet\.js 404/);

    // The rejection must NOT be cached: a second call retries and succeeds.
    const api = await wasm.loadWasmApi();
    expect(wasm.getWasmBootMode()).toBe('main-thread');
    expect(await api.ListEmitTargets()).toBe('{"targets":[]}');
  });

  test('uses the worker fast-path when the worker boot succeeds (no fallback, loader untouched)', async () => {
    const mockCall = vi
      .fn<(m: string, a: unknown[]) => Promise<string>>()
      .mockImplementation((m) => Promise.resolve(m === 'Capabilities' ? CAPABILITIES_JSON : '{"ok":true}'));
    const { createKoineWorkerClient } = await import('@/host/browser/workerClient');
    (createKoineWorkerClient as ReturnType<typeof vi.fn>).mockReturnValue({
      call: mockCall,
      whenReady: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      dispose: vi.fn(),
    });

    const wasm = await import('@/host/browser/wasm');
    const loader = vi.fn();
    wasm.__setDotnetModuleLoaderForTests(loader as never);

    const api = await wasm.loadWasmApi();

    expect(wasm.getWasmBootMode()).toBe('worker');
    expect(await api.DiagnoseWorkspace('[]')).toBe('{"ok":true}');
    expect(mockCall).toHaveBeenCalledWith('DiagnoseWorkspace', ['[]']);
    expect(loader).not.toHaveBeenCalled(); // the main-thread fallback was NOT taken
  });

  // Issue #359: the main-thread fallback loader must be CSP-safe and fast-failing. It prefers a direct
  // dynamic import (the same CSP-neutral path the worker uses), and only falls back to the inline
  // `<script type="module">` loader — which a strict CSP can block and which can't surface a DOM error
  // event — when the direct import throws (Vite's dev-server public-asset transform).

  test('main-thread fallback prefers the direct import — CSP-safe, no inline <script> injected', async () => {
    const { createKoineWorkerClient } = await import('@/host/browser/workerClient');
    (createKoineWorkerClient as ReturnType<typeof vi.fn>).mockReturnValue({
      call: vi.fn(),
      whenReady: vi.fn<() => Promise<void>>().mockRejectedValue(new Error('worker boot failed')),
      dispose: vi.fn(),
    });

    const wasm = await import('@/host/browser/wasm');
    // Leave __setDotnetModuleLoaderForTests at its default so the REAL importDotnetModule runs; stub
    // only the raw dynamic-import primitive so it resolves a fake dotnet module (no real `import()`).
    const directImport = vi.fn(fakeDotnetModule({ ListEmitTargets: () => '{"targets":[{"id":"csharp"}]}' }));
    wasm.__setEsModuleImporterForTests(directImport);

    const createSpy = vi.spyOn(document, 'createElement');
    const appendSpy = vi.spyOn(document.head, 'appendChild');

    const api = await wasm.loadWasmApi();

    expect(wasm.getWasmBootMode()).toBe('main-thread');
    expect(await api.ListEmitTargets()).toBe('{"targets":[{"id":"csharp"}]}');
    expect(directImport).toHaveBeenCalledOnce();
    // The CSP-safe direct import means NO inline <script> is injected (the pre-#359 loader always did).
    expect(createSpy).not.toHaveBeenCalledWith('script');
    expect(appendSpy).not.toHaveBeenCalled();

    createSpy.mockRestore();
    appendSpy.mockRestore();
  });

  test('falls back to the inline-<script> loader when the direct import throws (Vite dev-server case)', async () => {
    const { createKoineWorkerClient } = await import('@/host/browser/workerClient');
    (createKoineWorkerClient as ReturnType<typeof vi.fn>).mockReturnValue({
      call: vi.fn(),
      whenReady: vi.fn<() => Promise<void>>().mockRejectedValue(new Error('worker boot failed')),
      dispose: vi.fn(),
    });

    const wasm = await import('@/host/browser/wasm');
    // The direct import throws (the dev-server `?import` transform breaks it) → the inline-<script>
    // loader must take over and still boot.
    wasm.__setEsModuleImporterForTests(() =>
      Promise.reject(new Error('dev-server public-asset ?import transform failed')),
    );

    // happy-dom does not execute the injected module script, so simulate the browser: when the inline
    // <script> is appended, resolve via the global callback importEsModuleViaScript registered on window.
    const appendSpy = vi.spyOn(document.head, 'appendChild').mockImplementation((node) => {
      queueMicrotask(() => {
        const w = window as unknown as Record<string, (m: Record<string, unknown>) => void>;
        const resolveKey = Object.keys(w).find((k) => /^__koineDotnet_\d+$/.test(k));
        if (resolveKey) w[resolveKey](dotnetModuleValue({ Glossary: () => '{"markdown":"dev"}' }));
      });
      return node;
    });

    const api = await wasm.loadWasmApi();

    expect(wasm.getWasmBootMode()).toBe('main-thread');
    expect(await api.Glossary('[]')).toBe('{"markdown":"dev"}');
    expect(appendSpy).toHaveBeenCalled(); // the inline-<script> fallback WAS used

    appendSpy.mockRestore();
  });

  // Issue #643: the inline-<script> loader injects a one-shot `<script type="module">` whose only job is
  // to `import(url)` and call back through a `window` bridge. Once it has settled (success, DOM error, or
  // timeout) the node is inert and must be detached from `document.head` — leaving it attached is sloppy
  // housekeeping that accumulates a node per total-boot-failure retry under the dev server.

  test('detaches the injected inline-<script> from document.head once the loader settles (issue #643)', async () => {
    const { createKoineWorkerClient } = await import('@/host/browser/workerClient');
    (createKoineWorkerClient as ReturnType<typeof vi.fn>).mockReturnValue({
      call: vi.fn(),
      whenReady: vi.fn<() => Promise<void>>().mockRejectedValue(new Error('worker boot failed')),
      dispose: vi.fn(),
    });

    const wasm = await import('@/host/browser/wasm');
    // Force the direct import to throw so the dev-server inline-<script> loader takes over.
    wasm.__setEsModuleImporterForTests(() =>
      Promise.reject(new Error('dev-server public-asset ?import transform failed')),
    );

    // Genuinely attach the injected node (so `isConnected` is meaningful), then drive the success bridge
    // callback the browser would normally fire — happy-dom does not execute the injected module script.
    let injected: Element | undefined;
    const realAppend = document.head.appendChild.bind(document.head);
    const appendSpy = vi.spyOn(document.head, 'appendChild').mockImplementation((node) => {
      injected = node as Element;
      const appended = realAppend(node);
      queueMicrotask(() => {
        const w = window as unknown as Record<string, (m: Record<string, unknown>) => void>;
        const resolveKey = Object.keys(w).find((k) => /^__koineDotnet_\d+$/.test(k));
        if (resolveKey) w[resolveKey](dotnetModuleValue({ Glossary: () => '{"markdown":"dev"}' }));
      });
      return appended;
    });

    // Restore in `finally` so a future regression (node left attached) can't leave this real-append
    // spy installed and cascade into the sibling tests that assert appendChild is untouched.
    try {
      const api = await wasm.loadWasmApi();

      expect(wasm.getWasmBootMode()).toBe('main-thread');
      expect(await api.Glossary('[]')).toBe('{"markdown":"dev"}');
      // The injected node was genuinely attached, then detached once the loader settled (#643).
      expect(injected).toBeDefined();
      expect(injected?.isConnected).toBe(false);
      expect(document.head.contains(injected as Node)).toBe(false);
    } finally {
      injected?.remove();
      appendSpy.mockRestore();
    }
  });

  // Issue #365: the inline-<script> loader exists ONLY for Vite's dev-server public-asset (`?import`)
  // transform. In a built/deployed bundle there is no such transform, so a thrown direct import is a
  // genuine load error — it must reject PROMPTLY with the real error instead of stalling on the inline
  // loader's 8s blind timeout. The inline fallback is gated on `import.meta.env.DEV`.

  test('production build (DEV=false): a genuine direct-import failure rejects promptly — no inline <script> fallback', async () => {
    const { createKoineWorkerClient } = await import('@/host/browser/workerClient');
    (createKoineWorkerClient as ReturnType<typeof vi.fn>).mockReturnValue({
      call: vi.fn(),
      whenReady: vi.fn<() => Promise<void>>().mockRejectedValue(new Error('worker boot failed')),
      dispose: vi.fn(),
    });

    // Simulate a built/deployed bundle: `import.meta.env.DEV` is statically false there (vitest
    // defaults it to true). The inline loader is dev-server-only, so production must NOT take it.
    vi.stubEnv('DEV', false);

    const wasm = await import('@/host/browser/wasm');
    // The direct import throws a *genuine* production load error (e.g. dotnet.js 404) — not the
    // dev-server transform case — so it must propagate, not route through the inline loader.
    wasm.__setEsModuleImporterForTests(() =>
      Promise.reject(new Error('dotnet.js 404 (genuine production load failure)')),
    );

    const createSpy = vi.spyOn(document, 'createElement');
    const appendSpy = vi.spyOn(document.head, 'appendChild');

    // The real direct-import error propagates promptly; the inline-<script> loader is never reached.
    await expect(wasm.loadWasmApi()).rejects.toThrow(/dotnet\.js 404 \(genuine production load failure\)/);
    expect(createSpy).not.toHaveBeenCalledWith('script');
    expect(appendSpy).not.toHaveBeenCalled();

    createSpy.mockRestore();
    appendSpy.mockRestore();
    // env restore is handled by the describe-level afterEach (matches the house devMode.test.ts pattern).
  });

  // Issue #625: the worker fast-path is watchdog-guarded twice (koine.worker.ts BOOT_WATCHDOG_MS +
  // workerClient.ts BOOT_TIMEOUT_MS), so whenReady() always settles and the main-thread fallback runs.
  // But the fallback itself awaited dotnetModuleLoader / dotnet.create() / getAssemblyExports() with NO
  // ceiling — so a stalled prod runtime fetch turned the "never brick the studio" backstop into the exact
  // silent indefinite hang it exists to prevent (no error, no retry). The fallback must now fail fast.

  test('main-thread fallback times out instead of hanging when the runtime boot stalls (issue #625)', async () => {
    const { createKoineWorkerClient } = await import('@/host/browser/workerClient');
    (createKoineWorkerClient as ReturnType<typeof vi.fn>).mockReturnValue({
      call: vi.fn(),
      whenReady: vi.fn<() => Promise<void>>().mockRejectedValue(new Error('Koine worker timed out after 30s')),
      dispose: vi.fn(),
    });

    const wasm = await import('@/host/browser/wasm');

    vi.useFakeTimers();
    try {
      // A loader that never settles → bootMainThread() would hang forever without the timeout ceiling.
      wasm.__setDotnetModuleLoaderForTests(() => new Promise<Record<string, unknown>>(() => {}));

      const stalled = wasm.loadWasmApi();
      const rejection = expect(stalled).rejects.toThrow(/main-thread runtime boot did not settle/i);
      // Advance past the ceiling — the boot must reject (not hang). advanceTimersByTimeAsync flushes the
      // intervening microtasks (the worker whenReady() rejection → main-thread fallback → armed race).
      await vi.advanceTimersByTimeAsync(25_000);
      await rejection;

      // The rejection must NOT be cached (apiPromise cleared via attempt.catch) — a later call re-attempts
      // from scratch and can succeed once the runtime fetch recovers.
      wasm.__setDotnetModuleLoaderForTests(fakeDotnetModule({ ListEmitTargets: () => '{"targets":[]}' }));
      const api = await wasm.loadWasmApi();
      expect(wasm.getWasmBootMode()).toBe('main-thread');
      expect(await api.ListEmitTargets()).toBe('{"targets":[]}');
    } finally {
      vi.useRealTimers();
    }
  });

  test('a main-thread boot that resolves under the ceiling clears its timeout (no leak) — issue #625', async () => {
    const { createKoineWorkerClient } = await import('@/host/browser/workerClient');
    (createKoineWorkerClient as ReturnType<typeof vi.fn>).mockReturnValue({
      call: vi.fn(),
      whenReady: vi.fn<() => Promise<void>>().mockRejectedValue(new Error('worker boot failed')),
      dispose: vi.fn(),
    });

    const wasm = await import('@/host/browser/wasm');

    vi.useFakeTimers();
    try {
      wasm.__setDotnetModuleLoaderForTests(fakeDotnetModule({ Glossary: () => '{"markdown":"ok"}' }));

      const api = await wasm.loadWasmApi();
      expect(wasm.getWasmBootMode()).toBe('main-thread');
      expect(await api.Glossary('[]')).toBe('{"markdown":"ok"}');
      // A boot that resolved under the ceiling must have cleared its timeout timer — no dangling timer
      // (and so no unhandled rejection from a timeout that fires after a successful boot).
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
