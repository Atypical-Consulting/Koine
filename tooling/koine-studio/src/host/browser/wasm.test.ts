import { describe, expect, test, vi, beforeEach } from 'vitest';
import { guardWasmSurface } from '@/host/browser/wasm';

// ---------------------------------------------------------------------------
// guardWasmSurface — existing tests (unchanged)
// ---------------------------------------------------------------------------

describe('guardWasmSurface', () => {
  test('passes through exports the bundle does provide', () => {
    const glossary = vi.fn(() => '{"entries":[]}');
    const api = guardWasmSurface({ Glossary: glossary });

    expect(api.Glossary('[]')).toBe('{"entries":[]}');
    expect(glossary).toHaveBeenCalledWith('[]');
  });

  // Reproduces the reported bug: a stale public/koine-wasm/ bundle (built before #67) has no
  // GlossaryModel export, so `api.GlossaryModel(...)` would otherwise blow up with the cryptic
  // "TypeError: api.GlossaryModel is not a function". The guard turns it into a fix-me message.
  test('a missing export throws an actionable rebuild message instead of a raw TypeError', () => {
    const api = guardWasmSurface({ Glossary: () => '{}' });

    expect(() => api.GlossaryModel('[]')).toThrowError(/GlossaryModel.*stale.*npm run build:wasm/s);
  });

  test('symbol access is untouched so the surface can still be inspected/awaited', () => {
    const api = guardWasmSurface({}) as unknown as Record<PropertyKey, unknown>;
    expect(api[Symbol.toPrimitive]).toBeUndefined();
  });

  // Regression: the Promise resolution machinery probes `value.then` to decide if the resolved value
  // is a thenable. If the guard returned a throwing function for the (unknown, non-export) string
  // `then`, the proxy would masquerade as a thenable and the whole language-server boot would reject
  // with a bogus `export "then" is missing`. So `then` and other non-export strings must pass through.
  test('non-export string props (then, toString) pass through so the proxy is not a fake thenable', () => {
    const api = guardWasmSurface({ Glossary: () => '{}' }) as unknown as Record<string, unknown>;
    expect(api.then).toBeUndefined();
    expect(typeof api.toString).toBe('function');
  });

  test('a proxied surface resolves cleanly when returned from a promise (await does not throw)', async () => {
    const api = guardWasmSurface({ Glossary: () => '{"entries":[]}' });
    await expect(Promise.resolve(api)).resolves.toBe(api);
  });
});

// ---------------------------------------------------------------------------
// loadWasmApi — worker-client proxy tests (new)
// ---------------------------------------------------------------------------
//
// Strategy: vi.mock './workerClient' so createKoineWorkerClient returns a fake WorkerClient whose
// `call()` resolves to canned strings and `whenReady()` resolves immediately. This avoids the
// need for a real Worker (happy-dom has none) while exercising the real loadWasmApi() proxy logic.
//
// The loadWasmApi function caches its promise in a module-level variable. We use vi.resetModules()
// + dynamic import in each test to get a fresh singleton per test.

vi.mock('@/host/browser/workerClient', () => {
  // These are replaced per-test by swapping the mock implementation.
  return {
    createKoineWorkerClient: vi.fn(),
  };
});

describe('loadWasmApi — worker proxy', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  test('resolves to a proxy that forwards a known method to client.call and returns the result', async () => {
    const mockCall = vi.fn<(method: string, args: unknown[]) => Promise<string>>();
    mockCall.mockResolvedValue('{"ok":true}');

    const { createKoineWorkerClient } = await import('@/host/browser/workerClient');
    (createKoineWorkerClient as ReturnType<typeof vi.fn>).mockReturnValue({
      call: mockCall,
      whenReady: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      dispose: vi.fn(),
    });

    const { loadWasmApi } = await import('@/host/browser/wasm');
    const api = await loadWasmApi();
    const result = await api.DiagnoseWorkspace('[]');

    expect(mockCall).toHaveBeenCalledWith('DiagnoseWorkspace', ['[]']);
    expect(result).toBe('{"ok":true}');
  });

  test('a known export the worker rejects as missing still throws the stale-bundle message', async () => {
    const mockCall = vi.fn<(method: string, args: unknown[]) => Promise<string>>();
    // The worker throws: 'Koine WASM export "GlossaryModel" is not a function'
    mockCall.mockRejectedValue(new Error('Koine WASM export "GlossaryModel" is not a function'));

    const { createKoineWorkerClient } = await import('@/host/browser/workerClient');
    (createKoineWorkerClient as ReturnType<typeof vi.fn>).mockReturnValue({
      call: mockCall,
      whenReady: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      dispose: vi.fn(),
    });

    const { loadWasmApi } = await import('@/host/browser/wasm');
    const api = await loadWasmApi();
    await expect(api.GlossaryModel('[]')).rejects.toThrow(/GlossaryModel.*stale.*npm run build:wasm/s);
  });

  test('non-export string props (then) pass through so the resolved proxy is not a fake thenable', async () => {
    const mockCall = vi.fn<(method: string, args: unknown[]) => Promise<string>>();
    mockCall.mockResolvedValue('{}');

    const { createKoineWorkerClient } = await import('@/host/browser/workerClient');
    (createKoineWorkerClient as ReturnType<typeof vi.fn>).mockReturnValue({
      call: mockCall,
      whenReady: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      dispose: vi.fn(),
    });

    const { loadWasmApi } = await import('@/host/browser/wasm');
    const api = await loadWasmApi();
    // await on the api object itself must not throw (thenable probe regression)
    const resolved = await Promise.resolve(api);
    expect(resolved).toBe(api);
  });
});
