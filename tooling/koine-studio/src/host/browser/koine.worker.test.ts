// Round-trip test for the id-correlated WorkerClient. Happy-dom has no real Worker, so we inject a
// controllable fake (WorkerLike) that lets the test drive replies by calling `fake.onmessage(...)`.
// The tests verify real client behavior: id correlation, resolve/reject routing, the `ready` signal,
// cancellation (supersede + terminate/respawn), and AbortSignal integration.
import { describe, expect, it, vi } from 'vitest';
import { createWorkerClient } from '@/host/browser/workerClient';

// ---------------------------------------------------------------------------
// Fake WorkerLike: a controllable postMessage/onmessage pair
// ---------------------------------------------------------------------------

/** A minimal in-process worker double. Tests drive it by calling `deliver(data)`. */
function makeFakeWorker() {
  // The message handler the client installs after construction.
  let messageHandler: ((ev: { data: unknown }) => void) | null = null;

  const fake = {
    postMessage: vi.fn<(msg: unknown) => void>(),
    get onmessage(): ((ev: { data: unknown }) => void) | null {
      return messageHandler;
    },
    set onmessage(handler: ((ev: { data: unknown }) => void) | null) {
      messageHandler = handler;
    },
    terminate: vi.fn<() => void>(),
    /** Push a message from the "worker" into the client. */
    deliver(data: unknown): void {
      if (messageHandler) messageHandler({ data });
    },
  };

  return fake;
}

/** Returns a factory function that creates a new fake worker each call, tracking all instances. */
function makeWorkerFactory() {
  const instances: ReturnType<typeof makeFakeWorker>[] = [];
  const factory = () => {
    const w = makeFakeWorker();
    instances.push(w);
    return w;
  };
  factory.instances = instances;
  return factory;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WorkerClient (workerClient.ts)', () => {
  it('call() resolves with the result string of a correlated ok:true reply', async () => {
    const factory = makeWorkerFactory();
    const client = createWorkerClient(factory);
    const fake = factory.instances[0];

    // Start the call (don't await yet — we need to deliver the reply first).
    const pending = client.call('Echo', ['hello']);

    // The client should have posted a request to the worker.
    expect(fake.postMessage).toHaveBeenCalledOnce();
    const req = fake.postMessage.mock.calls[0][0] as { id: number; method: string; args: unknown[] };
    expect(req).toMatchObject({ method: 'Echo', args: ['hello'] });
    expect(typeof req.id).toBe('number');

    // Deliver the correlated ok:true reply.
    fake.deliver({ id: req.id, ok: true, result: 'world' });

    await expect(pending).resolves.toBe('world');
  });

  it('call() rejects with the error string of a correlated ok:false reply', async () => {
    const factory = makeWorkerFactory();
    const client = createWorkerClient(factory);
    const fake = factory.instances[0];

    const pending = client.call('Explode', []);

    const req = fake.postMessage.mock.calls[0][0] as { id: number };
    fake.deliver({ id: req.id, ok: false, error: 'something went wrong' });

    await expect(pending).rejects.toThrow('something went wrong');
  });

  it('replies with non-matching ids do not settle the wrong pending call', async () => {
    const factory = makeWorkerFactory();
    const client = createWorkerClient(factory);
    const fake = factory.instances[0];

    const pending = client.call('Echo', ['x']);
    const req = fake.postMessage.mock.calls[0][0] as { id: number };

    // Deliver a reply with the wrong id first — pending must still be waiting.
    fake.deliver({ id: req.id + 999, ok: true, result: 'wrong' });

    // Deliver the correct reply.
    fake.deliver({ id: req.id, ok: true, result: 'correct' });

    await expect(pending).resolves.toBe('correct');
  });

  it('whenReady() resolves once a `ready` message arrives', async () => {
    const factory = makeWorkerFactory();
    const client = createWorkerClient(factory);
    const fake = factory.instances[0];

    const readyPromise = client.whenReady();
    // Not yet ready.
    let resolved = false;
    void readyPromise.then(() => { resolved = true; });

    // Deliver ready signal.
    fake.deliver({ type: 'ready' });

    await readyPromise;
    expect(resolved).toBe(true);
  });

  it('whenReady() rejects on a boot-failure signal', async () => {
    const factory = makeWorkerFactory();
    const client = createWorkerClient(factory);
    const fake = factory.instances[0];

    const readyPromise = client.whenReady();
    fake.deliver({ type: 'boot-failure', error: 'dotnet.create() failed' });

    await expect(readyPromise).rejects.toThrow('dotnet.create() failed');
  });

  it('multiple concurrent calls are independently correlated', async () => {
    const factory = makeWorkerFactory();
    const client = createWorkerClient(factory);
    const fake = factory.instances[0];

    const p1 = client.call('A', []);
    const p2 = client.call('B', []);

    const req1 = fake.postMessage.mock.calls[0][0] as { id: number };
    const req2 = fake.postMessage.mock.calls[1][0] as { id: number };

    // Different ids.
    expect(req1.id).not.toBe(req2.id);

    // Deliver in reverse order.
    fake.deliver({ id: req2.id, ok: true, result: 'b-result' });
    fake.deliver({ id: req1.id, ok: true, result: 'a-result' });

    await expect(p1).resolves.toBe('a-result');
    await expect(p2).resolves.toBe('b-result');
  });

  it('dispose() calls terminate() on the underlying worker', () => {
    const factory = makeWorkerFactory();
    const client = createWorkerClient(factory);
    const fake = factory.instances[0];

    client.dispose();
    expect(fake.terminate).toHaveBeenCalledOnce();
  });

  // ---------------------------------------------------------------------------
  // Cancellation: supersede (soft cancel)
  // ---------------------------------------------------------------------------

  it('cancel(id) drops the pending entry so a late reply is ignored and B settles normally', async () => {
    const factory = makeWorkerFactory();
    const client = createWorkerClient(factory);
    const fake = factory.instances[0];

    // Start call A and call B.
    const promiseA = client.call('SlowOp', ['data-a']);
    const promiseB = client.call('FastOp', ['data-b']);

    const reqA = fake.postMessage.mock.calls[0][0] as { id: number };
    const reqB = fake.postMessage.mock.calls[1][0] as { id: number };

    // Supersede call A (soft cancel — drop it from pending map).
    client.cancel(reqA.id);

    // Deliver A's late reply — it should be ignored (promise must NOT resolve with stale data).
    fake.deliver({ id: reqA.id, ok: true, result: 'stale-result-a' });

    // Deliver B's reply — it should settle normally.
    fake.deliver({ id: reqB.id, ok: true, result: 'result-b' });

    // B resolves correctly.
    await expect(promiseB).resolves.toBe('result-b');

    // A must NOT resolve with the stale data. It should either stay pending or have been rejected
    // with a cancellation error. Verify it does NOT resolve to 'stale-result-a' within a tick.
    let aResolved = false;
    let aValue: string | undefined;
    promiseA.then((v) => { aResolved = true; aValue = v; }).catch(() => { /* cancelled — ok */ });

    // Allow microtasks to flush.
    await Promise.resolve();
    await Promise.resolve();

    // A must not have resolved to the stale result.
    expect(aResolved ? aValue : undefined).not.toBe('stale-result-a');
  });

  it('call() with AbortSignal: aborting before reply rejects the call and drops the pending id', async () => {
    const factory = makeWorkerFactory();
    const client = createWorkerClient(factory);
    const fake = factory.instances[0];

    const ac = new AbortController();
    const p = client.call('SlowOp', ['x'], { signal: ac.signal });

    const req = fake.postMessage.mock.calls[0][0] as { id: number };

    // Abort the signal.
    ac.abort();

    // Promise must reject with an abort-like error.
    await expect(p).rejects.toThrow();

    // A late reply from the worker for that id must be ignored (id already dropped).
    // Deliver a late reply — it should NOT cause any unhandled rejection or settle p.
    expect(() => fake.deliver({ id: req.id, ok: true, result: 'too-late' })).not.toThrow();
  });

  // ---------------------------------------------------------------------------
  // Cancellation: terminateAndRespawn (hard cancel)
  // ---------------------------------------------------------------------------

  it('terminateAndRespawn() rejects all in-flight calls, terminates old worker, and re-establishes ready via new worker', async () => {
    const factory = makeWorkerFactory();
    const client = createWorkerClient(factory);
    const oldWorker = factory.instances[0];

    // Simulate the old worker booting (so the client has a ready signal from gen 0).
    oldWorker.deliver({ type: 'ready' });
    await client.whenReady();

    // Start two in-flight calls.
    const p1 = client.call('LongOp', ['a']);
    const p2 = client.call('LongOp', ['b']);

    // Hard cancel.
    client.terminateAndRespawn();

    // Old worker must be terminated.
    expect(oldWorker.terminate).toHaveBeenCalledOnce();

    // Both in-flight calls must reject with a cancellation error.
    await expect(p1).rejects.toThrow(/cancel/i);
    await expect(p2).rejects.toThrow(/cancel/i);

    // A new worker instance must have been created by the factory.
    expect(factory.instances.length).toBe(2);
    const newWorker = factory.instances[1];

    // whenReady() on the client must resolve when the new worker posts `ready`.
    const newReady = client.whenReady();
    newWorker.deliver({ type: 'ready' });
    await expect(newReady).resolves.toBeUndefined();

    // A subsequent call must go to the new worker (not the old one).
    const p3 = client.call('Ping', []);
    const req3 = newWorker.postMessage.mock.calls[0][0] as { id: number; method: string };
    expect(req3.method).toBe('Ping');
    newWorker.deliver({ id: req3.id, ok: true, result: 'pong' });
    await expect(p3).resolves.toBe('pong');
  });

  it('terminateAndRespawn() late reply from old worker does not settle a new call', async () => {
    const factory = makeWorkerFactory();
    const client = createWorkerClient(factory);
    const oldWorker = factory.instances[0];

    oldWorker.deliver({ type: 'ready' });
    await client.whenReady();

    // Start call on old generation.
    const p1 = client.call('Op', ['old']);
    const req1 = oldWorker.postMessage.mock.calls[0][0] as { id: number };

    // Hard cancel: terminates old worker, starts new worker.
    client.terminateAndRespawn();
    await expect(p1).rejects.toThrow(/cancel/i);

    const newWorker = factory.instances[1];
    newWorker.deliver({ type: 'ready' });
    await client.whenReady();

    // Start a call on the new generation.
    const p2 = client.call('Op', ['new']);
    // The new worker may reuse an id counter (in the new generation) that happens to match req1.id;
    // but the message comes from the OLD worker which is already terminated (onmessage is torn down).
    // Delivering a late message via the OLD worker's deliver() should not affect p2.
    oldWorker.deliver({ id: req1.id, ok: true, result: 'ghost-reply' });

    // p2 must not resolve to the ghost reply — still pending.
    let p2Resolved = false;
    p2.then(() => { p2Resolved = true; }).catch(() => { /* ok */ });
    await Promise.resolve();
    await Promise.resolve();
    expect(p2Resolved).toBe(false);

    // Settle p2 properly via the new worker.
    const req2 = newWorker.postMessage.mock.calls[0][0] as { id: number };
    newWorker.deliver({ id: req2.id, ok: true, result: 'real-reply' });
    await expect(p2).resolves.toBe('real-reply');
  });
});
