import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readRaw, writeRaw } from '@/shell/storage';

const KEY = 'koine.studio.test-raw';

describe('storage: readRaw/writeRaw', () => {
  beforeEach(() => localStorage.clear());

  it('round-trips a value through the real localStorage (happy path)', () => {
    expect(readRaw(KEY)).toBe(null);

    writeRaw(KEY, 'hello');

    expect(readRaw(KEY)).toBe('hello');
    expect(localStorage.getItem(KEY)).toBe('hello');
  });

  it('readRaw returns null when localStorage.getItem throws', () => {
    const getItem = vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    try {
      expect(readRaw(KEY)).toBe(null);
    } finally {
      getItem.mockRestore();
    }
  });

  it('writeRaw no-ops (never throws) when localStorage.setItem throws', () => {
    const setItem = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    try {
      expect(() => writeRaw(KEY, 'value')).not.toThrow();
    } finally {
      setItem.mockRestore();
    }
  });
});
