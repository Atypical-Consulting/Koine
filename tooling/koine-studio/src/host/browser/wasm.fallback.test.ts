// Issue #357: a failed worker boot must NOT brick the studio. loadWasmApi() falls back to a
// main-thread boot when the worker boot rejects (boot-failure OR timeout), and getWasmBootMode()
// reports which path won. Happy-dom has no real Worker and no real .NET runtime, so we mock the
// worker client and inject a fake dotnet module loader (the __setDotnetModuleLoaderForTests seam).
import { describe, expect, test, vi, beforeEach } from 'vitest';

vi.mock('@/host/browser/workerClient', () => ({ createKoineWorkerClient: vi.fn() }));

/** A fake dotnet ES module whose CompilerInterop exposes the given methods. */
function fakeDotnetModule(interop: Record<string, unknown>) {
  return async () => ({
    dotnet: {
      create: async () => ({
        getConfig: () => ({ mainAssemblyName: 'Koine.Wasm.dll' }),
        getAssemblyExports: async () => ({ Koine: { Wasm: { CompilerInterop: interop } } }),
      }),
    },
  });
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
});
