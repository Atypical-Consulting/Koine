import { describe, it, expect } from 'vitest';
import { localStorageFlag, type StorageLike } from '@/shell/localStorageFlag';

// An in-memory Storage stand-in so each test controls the flag deterministically (the global
// happy-dom shim is shared across files; a fresh map per test keeps the cases isolated).
function memStorage(seed: Record<string, string> = {}): StorageLike & { map: Map<string, string> } {
  const m = new Map<string, string>(Object.entries(seed));
  return {
    map: m,
    getItem: (k) => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  };
}

// A storage stand-in whose every method throws (Safari private mode / disabled cookies / sandboxed
// iframe) — proves the helper degrades to a silent no-op rather than crashing.
const throwing: StorageLike = {
  getItem: () => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('blocked');
  },
  removeItem: () => {
    throw new Error('blocked');
  },
};

const KEY = 'koine.studio.test-flag';

describe('localStorageFlag', () => {
  it('isSet() is false until set() is called', () => {
    const flag = localStorageFlag(KEY, memStorage());
    expect(flag.isSet()).toBe(false);
  });

  it("set() writes the '1' sentinel and isSet() then reads true", () => {
    const storage = memStorage();
    const flag = localStorageFlag(KEY, storage);

    flag.set();

    expect(storage.getItem(KEY)).toBe('1');
    expect(flag.isSet()).toBe(true);
  });

  it('clear() removes the key so isSet() reads false again', () => {
    const storage = memStorage({ [KEY]: '1' });
    const flag = localStorageFlag(KEY, storage);
    expect(flag.isSet()).toBe(true);

    flag.clear();

    expect(storage.getItem(KEY)).toBe(null);
    expect(flag.isSet()).toBe(false);
  });

  it('honours a pre-existing sentinel already in storage', () => {
    const flag = localStorageFlag(KEY, memStorage({ [KEY]: '1' }));
    expect(flag.isSet()).toBe(true);
  });

  it("treats any non-'1' value as unset", () => {
    const flag = localStorageFlag(KEY, memStorage({ [KEY]: 'yes' }));
    expect(flag.isSet()).toBe(false);
  });

  it('scopes reads and writes to its own key', () => {
    const storage = memStorage();
    const a = localStorageFlag('koine.studio.flag-a', storage);
    const b = localStorageFlag('koine.studio.flag-b', storage);

    a.set();

    expect(a.isSet()).toBe(true);
    expect(b.isSet()).toBe(false);
  });

  it('isSet() returns false when storage throws on read (no crash)', () => {
    const flag = localStorageFlag(KEY, throwing);
    expect(flag.isSet()).toBe(false);
  });

  it('set() and clear() never throw when storage throws on write', () => {
    const flag = localStorageFlag(KEY, throwing);
    expect(() => flag.set()).not.toThrow();
    expect(() => flag.clear()).not.toThrow();
  });

  it('falls back to the real localStorage when no storage is injected', () => {
    // happy-dom provides a working localStorage; round-trip through the default adapter.
    const key = 'koine.studio.default-adapter-probe';
    const flag = localStorageFlag(key);
    flag.clear();
    expect(flag.isSet()).toBe(false);

    flag.set();
    expect(flag.isSet()).toBe(true);
    expect(localStorage.getItem(key)).toBe('1');

    flag.clear();
    expect(flag.isSet()).toBe(false);
  });
});
