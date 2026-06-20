import { describe, expect, test } from 'vitest';
import { dirtyBuffers, dirtyCount, saveAllDirtyBuffers } from './dirty';

interface FakeBuffer {
  path: string | null;
  text: string;
  dirty: boolean;
}

function buf(path: string | null, dirty: boolean, text = 'x'): FakeBuffer {
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
      write: async (x) => void written.push(x.path!),
      saveScratch: async () => {
        throw new Error('no scratch buffer expected');
      },
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

  test('routes a path-less (scratch) dirty buffer through saveScratch, not write', async () => {
    const s = buf(null, true);
    const m = map(['scratch', s]);
    const writes: FakeBuffer[] = [];
    const scratched: FakeBuffer[] = [];
    const saved = await saveAllDirtyBuffers(m, {
      write: async (x) => void writes.push(x),
      saveScratch: async (x) => void scratched.push(x),
      onError: () => {
        throw new Error('no error expected');
      },
    });
    expect(writes).toEqual([]);
    expect(scratched).toEqual([s]);
    // saveScratch owns the path-less buffer's clean/promote bookkeeping, so it is not counted here.
    expect(saved).toBe(0);
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
      saveScratch: async () => {
        throw new Error('no scratch buffer expected');
      },
      onError: (x) => void errored.push(x.path!),
    });
    expect(saved).toBe(2); // a and c
    expect(a.dirty).toBe(false);
    expect(c.dirty).toBe(false);
    expect(bad.dirty).toBe(true); // still dirty after the failure
    expect(errored).toEqual(['/bad']);
  });
});
