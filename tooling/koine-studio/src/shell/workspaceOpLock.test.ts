import { describe, expect, it, vi } from 'vitest';

import { createWorkspaceOpLock } from '@/shell/workspaceOpLock';

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

/** An op that stays pending until its `resolve`/`reject` is called, so a test can hold the lock open. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('workspaceOpLock (#1088)', () => {
  it('serializes two ops: the second does not start until the first settles', async () => {
    const lock = createWorkspaceOpLock();
    const first = deferred<void>();
    const firstOp = vi.fn(() => first.promise);
    const secondOp = vi.fn(async () => undefined);

    void lock.run(firstOp);
    void lock.run(secondOp);
    await flush();

    // The first op is still in flight, so the second must not have started.
    expect(firstOp).toHaveBeenCalledOnce();
    expect(secondOp).not.toHaveBeenCalled();

    first.resolve();
    await flush();
    expect(secondOp).toHaveBeenCalledOnce();
  });

  it('runs an op immediately when the lock is idle', async () => {
    const lock = createWorkspaceOpLock();
    const op = vi.fn(async () => undefined);
    void lock.run(op);
    // Queued off an already-resolved promise, so it starts on the next microtask — not synchronously.
    expect(op).not.toHaveBeenCalled();
    await flush();
    expect(op).toHaveBeenCalledOnce();
  });

  it('resolves run() with the op’s value', async () => {
    const lock = createWorkspaceOpLock();
    await expect(lock.run(async () => 'opened')).resolves.toBe('opened');
  });

  it('rejects run() with the op’s error (the caller still sees the failure)', async () => {
    const lock = createWorkspaceOpLock();
    await expect(lock.run(async () => Promise.reject(new Error('open failed')))).rejects.toThrow('open failed');
  });

  // The queue must not wedge on a failed op: a workspace open that throws (a rejected import, a
  // cancelled picker) has to release the lock, or every later New/Open would hang forever.
  it('a rejected op does not wedge the queue — the next op still runs', async () => {
    const lock = createWorkspaceOpLock();
    const next = vi.fn(async () => 'ok');

    const failing = lock.run(async () => Promise.reject(new Error('boom')));
    const queued = lock.run(next);
    await expect(failing).rejects.toThrow('boom');

    await expect(queued).resolves.toBe('ok');
    expect(next).toHaveBeenCalledOnce();
  });

  // Ordering is FIFO: three ops enqueued back-to-back run in submission order, never interleaved.
  it('preserves FIFO order across three queued ops', async () => {
    const lock = createWorkspaceOpLock();
    const order: string[] = [];
    const op = (name: string) => async () => {
      order.push(`${name}:start`);
      await flush();
      order.push(`${name}:end`);
    };

    await Promise.all([lock.run(op('a')), lock.run(op('b')), lock.run(op('c'))]);

    expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end']);
  });

  // Two lock instances are independent — one boot's in-flight op must never block another's (the
  // suite boots the IDE repeatedly, and production creates exactly one lock per init()).
  it('separate lock instances do not block each other', async () => {
    const a = createWorkspaceOpLock();
    const b = createWorkspaceOpLock();
    const held = deferred<void>();
    const bOp = vi.fn(async () => undefined);

    void a.run(() => held.promise);
    void b.run(bOp);
    await flush();

    expect(bOp).toHaveBeenCalledOnce(); // b ran even though a is still holding its own lock
    held.resolve();
  });
});

// The observable busy surface (#1275): true from the moment an op is enqueued until the queue drains,
// so the UI can grey out the workspace-opening controls instead of letting a queued click read as a
// hang. Derived from the queue itself — never tracked separately — so it cannot drift from reality.
describe('workspaceOpLock busy state (#1275)', () => {
  it('busy() is false when idle, true from enqueue until the op settles', async () => {
    const lock = createWorkspaceOpLock();
    expect(lock.busy()).toBe(false);

    const held = deferred<void>();
    void lock.run(() => held.promise);
    // True SYNCHRONOUSLY at enqueue (the op only starts on the next microtask): a click handler that
    // just queued an op must already see the lock busy, or two fast clicks slip through together.
    expect(lock.busy()).toBe(true);
    await flush();
    expect(lock.busy()).toBe(true); // in flight

    held.resolve();
    await flush();
    expect(lock.busy()).toBe(false); // drained
  });

  it('busy() stays true across a queued op’s whole wait and clears only when the queue drains', async () => {
    const lock = createWorkspaceOpLock();
    const first = deferred<void>();
    const second = deferred<void>();
    void lock.run(() => first.promise);
    void lock.run(() => second.promise);
    await flush();
    expect(lock.busy()).toBe(true); // first in flight, second queued

    first.resolve();
    await flush();
    expect(lock.busy()).toBe(true); // the queued op is now the in-flight one — no false window between

    second.resolve();
    await flush();
    expect(lock.busy()).toBe(false);
  });

  it('onBusyChanged fires once per transition (not per enqueued op) and its unsubscribe stops delivery', async () => {
    const lock = createWorkspaceOpLock();
    const seen: boolean[] = [];
    const unsub = lock.onBusyChanged((busy) => seen.push(busy));

    const first = deferred<void>();
    void lock.run(() => first.promise);
    void lock.run(async () => undefined);
    // One busy→true transition for the pair — a queued op lands on an already-busy lock.
    expect(seen).toEqual([true]);

    first.resolve();
    await flush();
    expect(seen).toEqual([true, false]); // one busy→false once the whole queue drained

    unsub();
    await lock.run(async () => undefined);
    await flush();
    expect(seen).toEqual([true, false]); // no delivery after unsubscribe
  });

  // The case that matters most: a stuck-disabled toolbar is worse than the race. A failed op (a
  // rejected import, a picker error) must clear busy exactly as it releases the lock.
  it('a REJECTED op still clears busy', async () => {
    const lock = createWorkspaceOpLock();
    const seen: boolean[] = [];
    lock.onBusyChanged((busy) => seen.push(busy));

    await expect(lock.run(async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await flush();

    expect(lock.busy()).toBe(false);
    expect(seen).toEqual([true, false]);
  });

  it('a rejected op ahead of a queued one keeps busy true until the queued op finishes', async () => {
    const lock = createWorkspaceOpLock();
    const next = deferred<string>();

    const failing = lock.run(async () => Promise.reject(new Error('boom')));
    const queued = lock.run(() => next.promise);
    await expect(failing).rejects.toThrow('boom');
    expect(lock.busy()).toBe(true); // the queued op is still owed its turn

    next.resolve('ok');
    await expect(queued).resolves.toBe('ok');
    await flush();
    expect(lock.busy()).toBe(false);
  });
});
