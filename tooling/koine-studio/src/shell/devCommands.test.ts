import { afterEach, describe, expect, test, vi } from 'vitest';
import { devCommands } from '@/shell/devCommands';

afterEach(() => {
  vi.unstubAllEnvs();
});

const noop = () => {};

describe('devCommands', () => {
  test('registers the store-inspector command always (no longer gated by an early return)', () => {
    // Registered in both dev and prod; the dev gate now lives on the command's when() predicate so the
    // registry keeps it and the palette filters by isEnabled (#758).
    vi.stubEnv('DEV', false);
    expect(devCommands(noop).map((c) => c.id)).toEqual(['toggle-store-inspector']);
  });

  test('the command is enabled (when() === true) in dev builds', () => {
    vi.stubEnv('DEV', true);
    const cmd = devCommands(noop).find((c) => c.id === 'toggle-store-inspector')!;
    expect(cmd.when?.()).toBe(true);
  });

  test('the command is disabled (when() === false) in production builds', () => {
    vi.stubEnv('DEV', false);
    const cmd = devCommands(noop).find((c) => c.id === 'toggle-store-inspector')!;
    expect(cmd.when?.()).toBe(false);
  });
});
