import { describe, expect, test } from 'vitest';
import { dirtyBuffers, dirtyCount, handleBeforeUnload, saveAllDirtyBuffers, titleWithDirty } from '@/shell/dirty';

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

  // Regression: dirty was cleared unconditionally AFTER the awaited write, so an edit landing while
  // the write was in flight (auto-save + typing) got marked saved even though it never hit disk.
  test('an edit landing during the awaited write leaves that buffer dirty', async () => {
    const a = buf('/a', true, 'v1');
    const m = map(['a', a]);
    const saved = await saveAllDirtyBuffers(m, {
      write: async (x) => {
        // A keystroke lands while the write is in flight — the buffer moves past what is being written.
        x.text = 'v2';
        x.dirty = true;
      },
      onError: () => {
        throw new Error('no error expected');
      },
    });
    expect(saved).toBe(1); // the v1 write itself succeeded
    expect(a.dirty).toBe(true); // but v2 never hit disk — the buffer still counts as unsaved
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
