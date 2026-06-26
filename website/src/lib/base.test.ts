// Tests for the shared Astro base-path helper (basePath, issue #369).
// basePath() is pure base-path math: it reads import.meta.env.BASE_URL and strips any trailing
// slash. Under vitest BASE_URL defaults to '/', so the default result is ''. The sub-path cases use
// vi.stubEnv, which updates import.meta.env in vitest's dev transform.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { basePath } from './base';

describe('basePath — Astro base, trailing slash stripped', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns the empty string for the root base (the vitest default)', () => {
    // Under vitest import.meta.env.BASE_URL defaults to '/', so the stripped value is ''.
    expect(basePath()).toBe('');
  });

  it('never returns a value with a trailing slash and never throws', () => {
    expect(() => basePath()).not.toThrow();
    expect(basePath().endsWith('/')).toBe(false);
  });

  it('strips the trailing slash from a sub-path base ("/Koine/" → "/Koine")', () => {
    vi.stubEnv('BASE_URL', '/Koine/');
    expect(basePath()).toBe('/Koine');
  });

  it('maps an explicit root base "/" to ""', () => {
    vi.stubEnv('BASE_URL', '/');
    expect(basePath()).toBe('');
  });
});
