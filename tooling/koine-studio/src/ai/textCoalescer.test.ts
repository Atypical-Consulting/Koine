// Tests for makeTextCoalescer: the per-frame batcher behind the assistant's streamed deltas. The
// contract under test is exactly what aiPanel.ts leans on — a burst of push()es lands as ONE flush
// per frame (in order, concatenated), flushNow() is a synchronous drain that also cancels the pending
// frame (so no late frame can double-deliver or leak a turn's tail into the next), and an empty
// buffer never dispatches.
import { afterEach, describe, expect, test, vi } from 'vitest';
import { makeTextCoalescer } from '@/ai/textCoalescer';

/** Wait long enough for a scheduled animation frame (or the 16 ms fallback) to have fired. */
async function nextFrame(): Promise<void> {
  await new Promise((r) => setTimeout(r, 50));
}

describe('makeTextCoalescer', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('a burst of pushes flushes ONCE per frame with the deltas concatenated in order', async () => {
    const flush = vi.fn();
    const c = makeTextCoalescer(flush);
    c.push('a');
    c.push('b');
    c.push('c');
    expect(flush).not.toHaveBeenCalled(); // buffered, not per-delta
    await nextFrame();
    expect(flush).toHaveBeenCalledExactlyOnceWith('abc');
  });

  test('flushNow drains synchronously and cancels the pending frame (no double delivery)', async () => {
    const flush = vi.fn();
    const c = makeTextCoalescer(flush);
    c.push('hello ');
    c.push('world');
    c.flushNow();
    expect(flush).toHaveBeenCalledExactlyOnceWith('hello world');
    await nextFrame(); // the cancelled frame must not deliver again
    expect(flush).toHaveBeenCalledTimes(1);
  });

  test('flushNow on an empty buffer dispatches nothing and is idempotent', () => {
    const flush = vi.fn();
    const c = makeTextCoalescer(flush);
    c.flushNow();
    c.flushNow();
    expect(flush).not.toHaveBeenCalled();
  });

  test('pushing again after a flush starts a fresh batch', async () => {
    const flush = vi.fn();
    const c = makeTextCoalescer(flush);
    c.push('one');
    c.flushNow();
    c.push('two');
    await nextFrame();
    expect(flush.mock.calls).toEqual([['one'], ['two']]);
  });

  test('empty deltas are ignored (no frame is scheduled for nothing)', async () => {
    const flush = vi.fn();
    const c = makeTextCoalescer(flush);
    c.push('');
    await nextFrame();
    expect(flush).not.toHaveBeenCalled();
  });

  test('falls back to a setTimeout tick when requestAnimationFrame is unavailable', async () => {
    vi.stubGlobal('requestAnimationFrame', undefined);
    const flush = vi.fn();
    const c = makeTextCoalescer(flush);
    c.push('x');
    c.push('y');
    expect(flush).not.toHaveBeenCalled();
    await nextFrame();
    expect(flush).toHaveBeenCalledExactlyOnceWith('xy');
  });

  test('flushNow cancels the setTimeout fallback too', async () => {
    vi.stubGlobal('requestAnimationFrame', undefined);
    const flush = vi.fn();
    const c = makeTextCoalescer(flush);
    c.push('x');
    c.flushNow();
    await nextFrame();
    expect(flush).toHaveBeenCalledExactlyOnceWith('x');
  });
});
