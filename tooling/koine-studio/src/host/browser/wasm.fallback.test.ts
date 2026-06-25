// Issue #357: a failed worker boot must NOT brick the studio. loadWasmApi() falls back to a
// main-thread boot when the worker boot rejects (boot-failure OR timeout), and getWasmBootMode()
// reports which path won. Happy-dom has no real Worker and no real .NET runtime, so we mock the
// worker client and inject a fake dotnet module loader (the __setDotnetModuleLoaderForTests seam).
import { describe, expect, test, vi, beforeEach } from 'vitest';

vi.mock('@/host/browser/workerClient', () => ({ createKoineWorkerClient: vi.fn() }));

/** A fake dotnet ES module *value* whose CompilerInterop exposes the given methods. */
function dotnetModuleValue(interop: Record<string, unknown>) {
  return {
    dotnet: {
      create: async () => ({
        getConfig: () => ({ mainAssemblyName: 'Koine.Wasm.dll' }),
        getAssemblyExports: async () => ({ Koine: { Wasm: { CompilerInterop: interop } } }),
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
    const mockCall = vi.fn<(m: string, a: unknown[]) => Promise<string>>().mockResolvedValue('{"ok":true}');
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
});
