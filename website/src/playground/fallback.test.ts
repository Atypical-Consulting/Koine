// Guarded main-thread fallback for the Playground worker client (#510).
//
// When the worker never reaches `ready` — it hangs (the host's boot timeout fires) or posts an
// explicit `boot-failure` (the watchdog, #357/#358) — a `fallbackBoot` (a main-thread compiler boot)
// must take over so the Playground still works, instead of the client rejecting with a dead compiler.
// The worker fast-path stays FIRST; `fallbackBoot` fires only when `ready` never arrives. Existing
// no-arg callers are unaffected (additive option) — they still reject on the timeout.

import { describe, expect, it, vi, afterEach } from 'vitest';
import { createWorkerClient, type WorkerLike } from './workerClient';
import { bootMainThreadCompiler, __setDotnetImporterForTests } from './mainThreadBoot';

/** A fake module worker the host can drive: capture the installed `onmessage`, emit signals on demand. */
function makeFakeWorker() {
  const worker = {
    postMessage: vi.fn(),
    onmessage: null as ((ev: { data: unknown }) => void) | null,
    terminate: vi.fn(),
    /** Simulate the worker posting a `{data}` message back to the host. */
    emit(data: unknown) {
      this.onmessage?.({ data });
    },
  };
  return worker satisfies WorkerLike & { emit(data: unknown): void };
}

afterEach(() => {
  vi.useRealTimers();
  __setDotnetImporterForTests(null);
});

/** A stub dotnet.js ES module exposing a fixed CompilerInterop surface (no real wasm runtime in Node). */
function stubDotnetModule(interop: Record<string, unknown>) {
  return {
    dotnet: {
      create: async () => ({
        getConfig: () => ({ mainAssemblyName: 'Koine.Wasm' }),
        getAssemblyExports: async () => ({ Koine: { Wasm: { CompilerInterop: interop } } }),
      }),
    },
  };
}

describe('createWorkerClient guarded main-thread fallback (#510)', () => {
  it('falls back to fallbackBoot when the worker never reaches ready (boot timeout elapses)', async () => {
    vi.useFakeTimers();
    const worker = makeFakeWorker();
    const fallbackCall = vi.fn(async (method: string, _args: unknown[]) => `fallback:${method}`);
    const fallbackBoot = vi.fn(async () => fallbackCall);

    const client = createWorkerClient(() => worker, { fallbackBoot });
    const ready = client.whenReady();

    // The worker posts neither `ready` nor `boot-failure`; let the boot budget elapse.
    await vi.advanceTimersByTimeAsync(30_000);

    await expect(ready).resolves.toBeUndefined();
    expect(fallbackBoot).toHaveBeenCalledOnce();

    // Subsequent calls route to the main-thread fallback, NOT the dead worker.
    await expect(client.call('Compile', ['model'])).resolves.toBe('fallback:Compile');
    expect(worker.postMessage).not.toHaveBeenCalled();
  });

  it('falls back when the worker posts an explicit boot-failure (the watchdog)', async () => {
    const worker = makeFakeWorker();
    const fallbackCall = vi.fn(async () => 'ok');
    const fallbackBoot = vi.fn(async () => fallbackCall);

    const client = createWorkerClient(() => worker, { fallbackBoot });
    const ready = client.whenReady();

    worker.emit({ type: 'boot-failure', error: 'dotnet.create did not settle' });

    await expect(ready).resolves.toBeUndefined();
    expect(fallbackBoot).toHaveBeenCalledOnce();
    await expect(client.call('Diagnose', ['x'])).resolves.toBe('ok');
  });

  it('keeps the worker as the fast path — fallbackBoot is NOT called when the worker reaches ready', async () => {
    const worker = makeFakeWorker();
    const fallbackBoot = vi.fn(async () => vi.fn(async () => 'unused'));

    const client = createWorkerClient(() => worker, { fallbackBoot });
    const ready = client.whenReady();

    worker.emit({ type: 'ready' });

    await expect(ready).resolves.toBeUndefined();
    expect(fallbackBoot).not.toHaveBeenCalled();

    // Calls go to the worker, not the fallback.
    void client.call('Compile', ['m']);
    expect(worker.postMessage).toHaveBeenCalledOnce();
  });

  it('still rejects with the boot timeout when no fallbackBoot is supplied (current behaviour)', async () => {
    vi.useFakeTimers();
    const worker = makeFakeWorker();

    const client = createWorkerClient(() => worker); // no options — existing callers unaffected
    const ready = client.whenReady();
    const assertion = expect(ready).rejects.toThrow(/timed out after 30s/);

    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
  });

  it('rejects when BOTH the worker and the fallbackBoot fail (no silent dead compiler)', async () => {
    const worker = makeFakeWorker();
    const fallbackBoot = vi.fn(async () => {
      throw new Error('main-thread boot exploded');
    });

    const client = createWorkerClient(() => worker, { fallbackBoot });
    const ready = client.whenReady();
    const assertion = expect(ready).rejects.toThrow(/main-thread boot exploded/);

    worker.emit({ type: 'boot-failure', error: 'worker dead' });
    await assertion;
    expect(fallbackBoot).toHaveBeenCalledOnce();
  });
});

describe('bootMainThreadCompiler — the main-thread fallback boot (#510)', () => {
  it('boots the runtime and dispatches calls to the interop export', async () => {
    __setDotnetImporterForTests(async () =>
      stubDotnetModule({ Compile: (src: string, target: string) => `compiled:${src}:${target}` }),
    );

    const call = await bootMainThreadCompiler();
    await expect(call('Compile', ['model', 'csharp'])).resolves.toBe('compiled:model:csharp');
  });

  it('rejects an unknown export with the same message the worker uses', async () => {
    __setDotnetImporterForTests(async () => stubDotnetModule({}));

    const call = await bootMainThreadCompiler();
    await expect(call('Nope', [])).rejects.toThrow(/Koine WASM export "Nope" is not a function/);
  });
});
