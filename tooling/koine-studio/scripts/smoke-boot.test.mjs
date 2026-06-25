/**
 * Unit tests for `classifyBootOutcome` (scripts/smoke-boot.mjs) — issue #359.
 *
 * The full smoke-test drives a real Chromium against a built `dist/`, which is too heavy for the unit
 * suite. The *verdict* logic is split out as a pure function so its branches — especially the new
 * "worker failed to load/parse" vs "boot hung" distinction — are tested here without a browser.
 * Importing smoke-boot.mjs is side-effect-free (the server/browser launch is guarded behind a
 * run-directly check), so this import never starts Playwright.
 *
 * Run:  npx vitest run scripts/smoke-boot.test.mjs   (or just: npm test)
 */
import { describe, test, expect } from 'vitest';
import { classifyBootOutcome } from './smoke-boot.mjs';

const TIMEOUT_MS = 60_000;

/** Defaults for a healthy-ish run; each test overrides the fields it cares about. */
function outcome(overrides) {
  return classifyBootOutcome({
    verdict: 'timeout',
    reachedReady: false,
    frameworkResponses: 5,
    okReplies: 0,
    timeoutMs: TIMEOUT_MS,
    ...overrides,
  });
}

describe('classifyBootOutcome (issue #359)', () => {
  test('ready + RPC round-trip → pass', () => {
    const r = outcome({ verdict: 'ready', reachedReady: true, okReplies: 3 });
    expect(r.ok).toBe(true);
    expect(r.status).toBe('ready');
    expect(r.message).toContain('3 ok replies');
  });

  test('worker `error` event → load/parse failure (distinct, not "boot hung")', () => {
    // A broken worker chunk fires an `error` event — even with assets somehow counted, it must be
    // labelled a load/parse failure, never a hang. This is the fast-exit path.
    const r = outcome({ verdict: 'worker-error', frameworkResponses: 0 });
    expect(r.ok).toBe(false);
    expect(r.status).toBe('load-parse-failure');
    expect(r.message).toMatch(/load\/parse/);
    expect(r.message).toMatch(/error event/);
    expect(r.message).not.toMatch(/boot hung/);
  });

  test('timeout with zero _framework responses → load/parse failure', () => {
    // No worker `error` fired, but the worker never fetched a single runtime asset → it never ran.
    const r = outcome({ verdict: 'timeout', frameworkResponses: 0 });
    expect(r.ok).toBe(false);
    expect(r.status).toBe('load-parse-failure');
    expect(r.message).toMatch(/_framework/);
    expect(r.message).not.toMatch(/boot hung/);
  });

  test('explicit boot-failure signal (assets fetched) → boot-failure', () => {
    const r = outcome({ verdict: 'boot-failure', frameworkResponses: 7 });
    expect(r.ok).toBe(false);
    expect(r.status).toBe('boot-failure');
    expect(r.message).toMatch(/boot failure/);
  });

  test('ready but no RPC round-trip within the timeout → no-rpc', () => {
    const r = outcome({ verdict: 'timeout', reachedReady: true, frameworkResponses: 9 });
    expect(r.ok).toBe(false);
    expect(r.status).toBe('no-rpc');
    expect(r.message).toMatch(/post-boot message channel/);
  });

  test('timeout with assets fetched but never settled → boot hung', () => {
    const r = outcome({ verdict: 'timeout', reachedReady: false, frameworkResponses: 12 });
    expect(r.ok).toBe(false);
    expect(r.status).toBe('hung');
    expect(r.message).toMatch(/boot hung/);
  });

  test('the timeout window is reported in seconds in the hang/no-rpc messages', () => {
    expect(outcome({ verdict: 'timeout', frameworkResponses: 4 }).message).toContain('60s');
    expect(outcome({ verdict: 'timeout', reachedReady: true, frameworkResponses: 4 }).message).toContain('60s');
  });
});
