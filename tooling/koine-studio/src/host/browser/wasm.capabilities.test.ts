// Issue #330: the studio verifies its compiler surface at BOOT from the bundle's self-describing
// Capabilities() export — instead of a hand-maintained export list that drifts and only trips at the
// first failing call. loadWasmApi() queries Capabilities() right after the runtime resolves, derives the
// proxy's forward set from `exports`, and warns ONCE at boot if the bundle is missing a method this
// studio build needs. Happy-dom has no real Worker/.NET, so we mock the worker client.
import { describe, expect, test, vi, beforeEach } from 'vitest';

vi.mock('@/host/browser/workerClient', () => ({ createKoineWorkerClient: vi.fn() }));

/** A faithful Capabilities() payload reporting the given export names. */
function capsJson(exports: string[]): string {
  return JSON.stringify({ version: '9.9.9-test', exports, targets: [] });
}

/** Mock a worker client whose boot succeeds and whose call() returns canned values (Capabilities special-cased). */
async function mockWorker(capabilities: string[]) {
  const mockCall = vi.fn<(m: string, a: unknown[]) => Promise<string>>();
  mockCall.mockImplementation((method) =>
    Promise.resolve(method === 'Capabilities' ? capsJson(capabilities) : '{"ok":true}'),
  );
  const { createKoineWorkerClient } = await import('@/host/browser/workerClient');
  (createKoineWorkerClient as ReturnType<typeof vi.fn>).mockReturnValue({
    call: mockCall,
    whenReady: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    dispose: vi.fn(),
  });
  return mockCall;
}

describe('loadWasmApi — boot-time surface verification (issue #330)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  test("queries Capabilities() at boot and forwards the studio's API calls", async () => {
    const { HOST_DECLARED_EXPORTS } = await import('@/host/browser/wasm');
    const mockCall = await mockWorker([...HOST_DECLARED_EXPORTS]); // a complete, non-stale bundle

    const { loadWasmApi } = await import('@/host/browser/wasm');
    const api = await loadWasmApi();

    expect(mockCall).toHaveBeenCalledWith('Capabilities', []); // surface verified at boot...
    expect(await api.DiagnoseWorkspace('[]')).toBe('{"ok":true}'); // ...and the studio's calls forward
    expect(mockCall).toHaveBeenCalledWith('DiagnoseWorkspace', ['[]']);
  });

  test('a complete bundle boots without a staleness warning', async () => {
    const { HOST_DECLARED_EXPORTS } = await import('@/host/browser/wasm');
    await mockWorker([...HOST_DECLARED_EXPORTS]);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { loadWasmApi } = await import('@/host/browser/wasm');
    await loadWasmApi();

    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  test('warns ONCE at boot when the bundle omits a method this studio build needs (stale bundle)', async () => {
    // The bundle reports a surface MISSING DiagnoseWorkspace (and the rest) → stale.
    await mockWorker(['Capabilities']);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { loadWasmApi } = await import('@/host/browser/wasm');
    await loadWasmApi();

    // The staleness is surfaced at BOOT — naming the missing method and the rebuild command — instead of
    // staying hidden until the first call to the missing feature.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/stale.*DiagnoseWorkspace.*npm run build:wasm/s));
    warn.mockRestore();
  });

  test('a stale bundle ALSO keeps the actionable per-call error (not a bare TypeError)', async () => {
    // Boot detection is the early warning; the proxy is still the per-call backstop for anyone who
    // misses it. The bundle omits DiagnoseWorkspace, so the worker rejects the forwarded call as
    // "not a function" → the proxy re-raises the actionable rebuild message (not a cryptic TypeError).
    const mockCall = vi.fn<(m: string, a: unknown[]) => Promise<string>>();
    mockCall.mockImplementation((method) =>
      method === 'Capabilities'
        ? Promise.resolve(capsJson(['Capabilities']))
        : Promise.reject(new Error('Koine WASM export "DiagnoseWorkspace" is not a function')),
    );
    const { createKoineWorkerClient } = await import('@/host/browser/workerClient');
    (createKoineWorkerClient as ReturnType<typeof vi.fn>).mockReturnValue({
      call: mockCall,
      whenReady: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      dispose: vi.fn(),
    });

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { loadWasmApi } = await import('@/host/browser/wasm');
    const api = await loadWasmApi();

    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/stale.*npm run build:wasm/s)); // early warning
    await expect(api.DiagnoseWorkspace('[]')).rejects.toThrow(/DiagnoseWorkspace.*stale.*npm run build:wasm/s);
    warn.mockRestore();
  });
});
