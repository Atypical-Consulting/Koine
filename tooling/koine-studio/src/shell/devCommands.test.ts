import { afterEach, describe, expect, test, vi } from 'vitest';
import { devCommands } from '@/shell/devCommands';

afterEach(() => {
  vi.unstubAllEnvs();
});

const noop = () => {};

describe('devCommands', () => {
  test('includes the store-inspector command in dev builds', () => {
    vi.stubEnv('DEV', true);
    const cmds = devCommands(noop);
    expect(cmds.some((c) => c.id === 'toggle-store-inspector')).toBe(true);
  });

  test('is empty in production builds', () => {
    vi.stubEnv('DEV', false);
    expect(devCommands(noop)).toEqual([]);
  });
});
