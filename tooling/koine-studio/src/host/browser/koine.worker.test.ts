// Round-trip test for the id-correlated WorkerClient. Happy-dom has no real Worker, so we inject a
// controllable fake (WorkerLike) that lets the test drive replies by calling `fake.onmessage(...)`.
// The tests verify real client behavior: id correlation, resolve/reject routing, and the `ready` signal.
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WorkerClient (workerClient.ts)', () => {
  it('call() resolves with the result string of a correlated ok:true reply', async () => {
    const fake = makeFakeWorker();
    const client = createWorkerClient(fake);

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
    const fake = makeFakeWorker();
    const client = createWorkerClient(fake);

    const pending = client.call('Explode', []);

    const req = fake.postMessage.mock.calls[0][0] as { id: number };
    fake.deliver({ id: req.id, ok: false, error: 'something went wrong' });

    await expect(pending).rejects.toThrow('something went wrong');
  });

  it('replies with non-matching ids do not settle the wrong pending call', async () => {
    const fake = makeFakeWorker();
    const client = createWorkerClient(fake);

    const pending = client.call('Echo', ['x']);
    const req = fake.postMessage.mock.calls[0][0] as { id: number };

    // Deliver a reply with the wrong id first — pending must still be waiting.
    fake.deliver({ id: req.id + 999, ok: true, result: 'wrong' });

    // Deliver the correct reply.
    fake.deliver({ id: req.id, ok: true, result: 'correct' });

    await expect(pending).resolves.toBe('correct');
  });

  it('whenReady() resolves once a `ready` message arrives', async () => {
    const fake = makeFakeWorker();
    const client = createWorkerClient(fake);

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
    const fake = makeFakeWorker();
    const client = createWorkerClient(fake);

    const readyPromise = client.whenReady();
    fake.deliver({ type: 'boot-failure', error: 'dotnet.create() failed' });

    await expect(readyPromise).rejects.toThrow('dotnet.create() failed');
  });

  it('multiple concurrent calls are independently correlated', async () => {
    const fake = makeFakeWorker();
    const client = createWorkerClient(fake);

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
    const fake = makeFakeWorker();
    const client = createWorkerClient(fake);

    client.dispose();
    expect(fake.terminate).toHaveBeenCalledOnce();
  });
});
