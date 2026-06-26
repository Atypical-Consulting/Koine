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
    // Clear the hoisted createKoineWorkerClient mock's call history (resetModules only resets the
    // koine.ts singleton, not the mock) so per-test call-count assertions start from zero.
    vi.clearAllMocks();
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

  it('diagnose()/compile() forward the AbortSignal opts to the worker client call (#338/#353)', async () => {
    const mockCall = vi.fn<(method: string, args: unknown[], opts?: unknown) => Promise<string>>();
    mockCall.mockResolvedValue('[]');

    const { createKoineWorkerClient } = await import('./workerClient');
    (createKoineWorkerClient as ReturnType<typeof vi.fn>).mockReturnValue({
      call: mockCall,
      whenReady: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      terminateAndRespawn: vi.fn(),
      dispose: vi.fn(),
    });

    const { diagnose, compile } = await import('./koine');
    const ac = new AbortController();
    await diagnose('value Foo = { }', { signal: ac.signal });
    await compile('value Foo = { }', 'csharp', { signal: ac.signal });

    expect(mockCall).toHaveBeenCalledWith('Diagnose', ['value Foo = { }'], { signal: ac.signal });
    expect(mockCall).toHaveBeenCalledWith('Compile', ['value Foo = { }', 'csharp'], { signal: ac.signal });
  });

  it('terminateAndRespawn() restarts the booted worker and re-awaits the fresh generation (Stop path)', async () => {
    const mockTerminate = vi.fn();
    const mockWhenReady = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

    const { createKoineWorkerClient } = await import('./workerClient');
    (createKoineWorkerClient as ReturnType<typeof vi.fn>).mockReturnValue({
      call: vi.fn<(method: string, args: unknown[]) => Promise<string>>().mockResolvedValue('{}'),
      whenReady: mockWhenReady,
      terminateAndRespawn: mockTerminate,
      dispose: vi.fn(),
    });

    const { preloadCompiler, whenReady, terminateAndRespawn } = await import('./koine');
    preloadCompiler(); // boot the singleton
    await whenReady();

    terminateAndRespawn(); // Stop pressed
    await whenReady(); // the singleton now awaits the fresh generation

    expect(mockTerminate).toHaveBeenCalledTimes(1);
    // The SAME client object is reused (its worker is swapped) — no second client is created (no leak).
    expect(createKoineWorkerClient).toHaveBeenCalledTimes(1);
  });

  it('terminateAndRespawn() is a no-op when the runtime was never booted', async () => {
    const { createKoineWorkerClient } = await import('./workerClient');
    (createKoineWorkerClient as ReturnType<typeof vi.fn>).mockReturnValue({
      call: vi.fn(),
      whenReady: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      terminateAndRespawn: vi.fn(),
      dispose: vi.fn(),
    });

    const { terminateAndRespawn } = await import('./koine');
    expect(() => terminateAndRespawn()).not.toThrow();
    expect(createKoineWorkerClient).not.toHaveBeenCalled(); // nothing booted → nothing to terminate
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

describe('playground emit targets — sourced from ListEmitTargets (#438)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  /** Wire the mocked worker client so its `call()` is driven by `respond` (a fake `ListEmitTargets`). */
  async function mockWorkerCall(respond: (method: string, args: unknown[]) => Promise<string>) {
    const mockCall = vi.fn(respond);
    const { createKoineWorkerClient } = await import('./workerClient');
    (createKoineWorkerClient as ReturnType<typeof vi.fn>).mockReturnValue({
      call: mockCall,
      whenReady: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      dispose: vi.fn(),
    });
    return mockCall;
  }

  it('listEmitTargets() returns exactly the targets the runtime reports — not a hardcoded union', async () => {
    // Deliberately NOT the old hardcoded union (csharp/typescript/python/php/…): proves the selectable
    // set is sourced from the export, so a newly-shipped target (e.g. rust) surfaces with no website edit.
    const reported = [
      { id: 'csharp', displayName: 'C#', fileExtension: '.cs' },
      { id: 'rust', displayName: 'Rust', fileExtension: '.rs' },
    ];
    const mockCall = await mockWorkerCall(() => Promise.resolve(JSON.stringify({ targets: reported })));

    const { listEmitTargets } = await import('./koine');
    const result = await listEmitTargets();

    expect(mockCall).toHaveBeenCalledWith('ListEmitTargets', [], undefined);
    expect(result.map((t) => t.id)).toEqual(['csharp', 'rust']);
  });

  it('listEmitTargets() forwards the AbortSignal opts to the worker call (#338/#353)', async () => {
    const mockCall = await mockWorkerCall(() => Promise.resolve(JSON.stringify({ targets: [{ id: 'csharp', displayName: 'C#', fileExtension: '.cs' }] })));
    const { listEmitTargets } = await import('./koine');
    const ac = new AbortController();
    await listEmitTargets({ signal: ac.signal });
    expect(mockCall).toHaveBeenCalledWith('ListEmitTargets', [], { signal: ac.signal });
  });

  it('listEmitTargets() degrades gracefully to the built-in set when the export is missing/throws', async () => {
    await mockWorkerCall(() => Promise.reject(new Error('Koine WASM export "ListEmitTargets" is not a function')));
    const { listEmitTargets, BUILTIN_EMIT_TARGETS } = await import('./koine');
    const result = await listEmitTargets();
    expect(result.map((t) => t.id)).toEqual(BUILTIN_EMIT_TARGETS.map((t) => t.id));
    expect(result.length).toBeGreaterThan(0);
  });

  it('listEmitTargets() degrades gracefully when the runtime reports an empty list', async () => {
    await mockWorkerCall(() => Promise.resolve(JSON.stringify({ targets: [] })));
    const { listEmitTargets, BUILTIN_EMIT_TARGETS } = await import('./koine');
    const result = await listEmitTargets();
    expect(result.map((t) => t.id)).toEqual(BUILTIN_EMIT_TARGETS.map((t) => t.id));
  });
});
