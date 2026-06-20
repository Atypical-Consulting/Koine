import { describe, expect, test } from 'vitest';
import { dirtyBuffers, dirtyCount, handleBeforeUnload, saveAllDirtyBuffers, titleWithDirty } from './dirty';

interface FakeBuffer {
  path: string;
  text: string;
  dirty: boolean;
}

function buf(path: string, dirty: boolean, text = 'x'): FakeBuffer {
  return { path, text, dirty };
}

function map(...entries: [string, FakeBuffer][]): Map<string, FakeBuffer> {
  return new Map(entries);
}

describe('dirtyBuffers / dirtyCount', () => {
  test('empty map has no dirty buffers', () => {
    const m = map();
    expect(dirtyBuffers(m)).toEqual([]);
    expect(dirtyCount(m)).toBe(0);
  });

  test('all-clean workspace has no dirty buffers', () => {
    const m = map(['a', buf('/a', false)], ['b', buf('/b', false)]);
    expect(dirtyBuffers(m)).toEqual([]);
    expect(dirtyCount(m)).toBe(0);
  });

  test('returns only the dirty buffers, in iteration order', () => {
    const a = buf('/a', true);
    const b = buf('/b', false);
    const c = buf('/c', true);
    const m = map(['a', a], ['b', b], ['c', c]);
    expect(dirtyBuffers(m)).toEqual([a, c]);
    expect(dirtyCount(m)).toBe(2);
  });
});

describe('saveAllDirtyBuffers', () => {
  test('writes every dirty path-bearing buffer, clears its dirty flag, leaves clean ones untouched', async () => {
    const a = buf('/a', true);
    const b = buf('/b', false);
    const c = buf('/c', true);
    const m = map(['a', a], ['b', b], ['c', c]);
    const written: string[] = [];
    const saved = await saveAllDirtyBuffers(m, {
      write: async (x) => void written.push(x.path),
      onError: () => {
        throw new Error('no error expected');
      },
    });
    expect(written).toEqual(['/a', '/c']);
    expect(saved).toBe(2);
    expect(a.dirty).toBe(false);
    expect(c.dirty).toBe(false);
    expect(b.dirty).toBe(false); // was already clean — untouched
  });

  test('a failing write keeps that buffer dirty, reports it, and still saves the rest', async () => {
    const a = buf('/a', true);
    const bad = buf('/bad', true);
    const c = buf('/c', true);
    const m = map(['a', a], ['bad', bad], ['c', c]);
    const errored: string[] = [];
    const saved = await saveAllDirtyBuffers(m, {
      write: async (x) => {
        if (x.path === '/bad') throw new Error('disk full');
      },
      onError: (x) => void errored.push(x.path),
    });
    expect(saved).toBe(2); // a and c
    expect(a.dirty).toBe(false);
    expect(c.dirty).toBe(false);
    expect(bad.dirty).toBe(true); // still dirty after the failure
    expect(errored).toEqual(['/bad']);
  });
});

describe('titleWithDirty', () => {
  test('prefixes a bullet when there are unsaved files', () => {
    expect(titleWithDirty('Koine Studio', 1)).toBe('• Koine Studio');
    expect(titleWithDirty('Koine Studio', 3)).toBe('• Koine Studio');
  });

  test('returns the base title unchanged when nothing is unsaved', () => {
    expect(titleWithDirty('Koine Studio', 0)).toBe('Koine Studio');
  });

  test('does not double-prefix an already-marked title', () => {
    expect(titleWithDirty('• Koine Studio', 2)).toBe('• Koine Studio');
    expect(titleWithDirty('• Koine Studio', 0)).toBe('Koine Studio');
  });
});

describe('handleBeforeUnload', () => {
  function fakeEvent() {
    return {
      prevented: false,
      returnValue: undefined as unknown,
      preventDefault() {
        this.prevented = true;
      },
    };
  }

  test('blocks the unload and sets returnValue when there is unsaved work', () => {
    const e = fakeEvent();
    const blocked = handleBeforeUnload(e, () => true);
    expect(blocked).toBe(true);
    expect(e.prevented).toBe(true);
    expect(e.returnValue).toBeTruthy();
  });

  test('is a no-op when nothing is dirty', () => {
    const e = fakeEvent();
    const blocked = handleBeforeUnload(e, () => false);
    expect(blocked).toBe(false);
    expect(e.prevented).toBe(false);
    expect(e.returnValue).toBeUndefined();
  });
});
