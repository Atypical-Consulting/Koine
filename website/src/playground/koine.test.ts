// Tests for the playground koine.ts worker-backed wrapper.
//
// Strategy: vi.mock './workerClient' so createKoineWorkerClient returns a fake WorkerClient whose
// `call()` resolves to canned strings and `whenReady()` resolves immediately. This avoids the
// need for a real Worker (test env has none) while exercising the real diagnose/compile/
// preloadCompiler/whenReady logic in koine.ts.
//
// The koine module caches its clientPromise singleton. We use vi.resetModules()
// + dynamic import in each test to get a fresh singleton per test.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./workerClient', () => {
  return {
    createKoineWorkerClient: vi.fn(),
  };
});

describe('playground koine.ts — worker proxy', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('diagnose() round-trips through the mocked worker client and JSON.parses the result', async () => {
    const diagnostics = [{ severity: 'error', code: 'K001', message: 'test', line: 1, col: 1, endLine: 1, endCol: 5 }];
    const mockCall = vi.fn<(method: string, args: unknown[]) => Promise<string>>();
    mockCall.mockResolvedValue(JSON.stringify(diagnostics));

    const { createKoineWorkerClient } = await import('./workerClient');
    (createKoineWorkerClient as ReturnType<typeof vi.fn>).mockReturnValue({
      call: mockCall,
      whenReady: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      dispose: vi.fn(),
    });

    const { diagnose } = await import('./koine');
    const result = await diagnose('value Foo = { }');

    expect(mockCall).toHaveBeenCalledWith('Diagnose', ['value Foo = { }'], undefined);
    expect(result).toEqual(diagnostics);
  });

  it('compile() round-trips through the mocked worker client and JSON.parses the result', async () => {
    const compileResult = { ok: true, target: 'csharp', diagnostics: [], files: [{ path: 'Foo.cs', contents: '// ok' }] };
    const mockCall = vi.fn<(method: string, args: unknown[]) => Promise<string>>();
    mockCall.mockResolvedValue(JSON.stringify(compileResult));

    const { createKoineWorkerClient } = await import('./workerClient');
    (createKoineWorkerClient as ReturnType<typeof vi.fn>).mockReturnValue({
      call: mockCall,
      whenReady: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      dispose: vi.fn(),
    });

    const { compile } = await import('./koine');
    const result = await compile('value Foo = { }', 'csharp');

    expect(mockCall).toHaveBeenCalledWith('Compile', ['value Foo = { }', 'csharp'], undefined);
    expect(result).toEqual(compileResult);
  });

  it('capabilities() round-trips through the mocked worker client and JSON.parses the result (#330)', async () => {
    const caps = {
      version: '0.17.3',
      exports: ['Diagnose', 'Compile', 'Capabilities'],
      targets: [{ id: 'csharp', displayName: 'C#', fileExtension: '.cs' }],
    };
    const mockCall = vi.fn<(method: string, args: unknown[]) => Promise<string>>();
    mockCall.mockResolvedValue(JSON.stringify(caps));

    const { createKoineWorkerClient } = await import('./workerClient');
    (createKoineWorkerClient as ReturnType<typeof vi.fn>).mockReturnValue({
      call: mockCall,
      whenReady: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      dispose: vi.fn(),
    });

    const { capabilities } = await import('./koine');
    const result = await capabilities();

    expect(mockCall).toHaveBeenCalledWith('Capabilities', [], undefined);
    expect(result).toEqual(caps);
    expect(result.version).toBe('0.17.3'); // the version the playground renders comes from here
  });

  it('preloadCompiler() returns void synchronously (fire and forget — does not block)', async () => {
    // The whenReady mock that delays resolution; preloadCompiler must not await it
    let resolveWhenReady!: () => void;
    const slowReady = new Promise<void>((r) => { resolveWhenReady = r; });

    const { createKoineWorkerClient } = await import('./workerClient');
    (createKoineWorkerClient as ReturnType<typeof vi.fn>).mockReturnValue({
      call: vi.fn<(method: string, args: unknown[]) => Promise<string>>().mockResolvedValue('[]'),
      whenReady: vi.fn<() => Promise<void>>().mockReturnValue(slowReady),
      dispose: vi.fn(),
    });

    const { preloadCompiler } = await import('./koine');

    // preloadCompiler() is a void function — it must return synchronously
    const returnValue = preloadCompiler();
    expect(returnValue).toBeUndefined();

    // Resolve the slow ready to let the dangling promise settle (avoid unhandled rejection)
    resolveWhenReady();
    await slowReady;
  });

  it('whenReady() resolves once the worker client whenReady() resolves', async () => {
    let resolveReady!: () => void;
    const readyPromise = new Promise<void>((r) => { resolveReady = r; });

    const mockWhenReady = vi.fn<() => Promise<void>>().mockReturnValue(readyPromise);

    const { createKoineWorkerClient } = await import('./workerClient');
    (createKoineWorkerClient as ReturnType<typeof vi.fn>).mockReturnValue({
      call: vi.fn<(method: string, args: unknown[]) => Promise<string>>().mockResolvedValue('{}'),
      whenReady: mockWhenReady,
      dispose: vi.fn(),
    });

    const { whenReady, preloadCompiler } = await import('./koine');

    preloadCompiler(); // kick off the boot

    let resolved = false;
    const waitPromise = whenReady().then(() => { resolved = true; });

    // Not yet resolved
    expect(resolved).toBe(false);

    // Simulate worker ready signal
    resolveReady();
    await waitPromise;

    expect(resolved).toBe(true);
  });
});
