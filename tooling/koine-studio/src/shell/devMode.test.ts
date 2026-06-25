import { afterEach, describe, expect, test, vi } from 'vitest';
import { isDevMode } from '@/shell/devMode';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('isDevMode', () => {
  test('is true when import.meta.env.DEV is true (vite serve — run-ide / run-ide-web)', () => {
    vi.stubEnv('DEV', true);
    expect(isDevMode()).toBe(true);
  });

  test('is false when import.meta.env.DEV is false (vite build — shipped builds)', () => {
    vi.stubEnv('DEV', false);
    expect(isDevMode()).toBe(false);
  });
});
