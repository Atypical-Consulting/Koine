// Vitest setup (test-only). happy-dom 20.x ships no Web Storage, so modules that persist via
// `localStorage` (store.ts) can't be exercised without a shim. Install a minimal in-memory
// localStorage/sessionStorage on the global. Never bundled into the app — only vitest loads this.

// happy-dom ships no IndexedDB either; the secret store (secrets.ts) needs one. fake-indexeddb/auto
// installs an in-memory IndexedDB on the global. A fresh environment per test file isolates it.
import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';
import { afterEach, expect } from 'vitest';
import { cleanup } from '@testing-library/preact';
import * as axeMatchers from 'vitest-axe/matchers';

// Accessibility matcher. Registering it here (a setupFile) makes `expect(await axe(el)).toHaveNoViolations()`
// available to every test file. axe-core runs under happy-dom for the static-DOM rules the panels
// exercise (label, button-name, list/listitem, ARIA roles, color-independent checks) — verified before
// rollout. The WCAG 2.1 AA mandate (CLAUDE.md) is otherwise unenforced; these assertions close that gap.
expect.extend(axeMatchers);

// Unmount rendered Preact trees after every test. @testing-library/preact only auto-registers this when
// Vitest `globals` is on (it isn't here), so without it each render() leaks into document.body and the
// next test — harmless for scoped `container` queries, but an axe audit then trips over duplicated DOM
// (e.g. landmark-no-duplicate-banner). One global hook keeps the body clean for the whole suite.
afterEach(() => cleanup());

function makeStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k: string) => (m.has(k) ? (m.get(k) as string) : null),
    key: (i: number) => Array.from(m.keys())[i] ?? null,
    removeItem: (k: string) => void m.delete(k),
    setItem: (k: string, v: string) => void m.set(k, String(v)),
  } as Storage;
}

const g = globalThis as unknown as { localStorage?: Storage; sessionStorage?: Storage; crypto?: Crypto };
// happy-dom 20.x now exposes a `localStorage` on the global that lacks the full Web Storage surface
// (notably `clear`), which would shadow our shim if we only checked for its absence. Install the
// in-memory shim whenever Storage is missing OR incomplete, so every test sees a real Storage.
if (typeof g.localStorage?.clear !== 'function') g.localStorage = makeStorage();
if (typeof g.sessionStorage?.clear !== 'function') g.sessionStorage = makeStorage();

// secrets.ts needs Web Crypto (crypto.subtle). happy-dom may not expose it; back it with Node's
// WebCrypto so AES-GCM encrypt/decrypt behaves as it does in the browser.
if (!g.crypto?.subtle) g.crypto = webcrypto as unknown as Crypto;

// requestAnimationFrame shim (#493). CodeMirror's EditorView captures its owning window as `this.win`
// and reads `this.win.requestAnimationFrame` from a DEFERRED measure (DOMObserver.onResize schedules a
// 50ms setTimeout -> view.requestMeasure()). When that timer fires after the owning test/file has ended
// and happy-dom has torn the window's rAF down, the read throws an uncaught
// `TypeError: this.win.requestAnimationFrame is not a function`, which Vitest counts as a run error and
// exits the worker non-zero — failing the studio job despite a fully green suite (same "green suite,
// crashing teardown" shape as #414). Destroying every EditorView in test teardown (editorSession.test.ts
// & peers) is the operative fix; this shim is the defense-in-depth net: it guarantees a setTimeout-backed
// rAF/cAF whenever the host lacks one — e.g. a future happy-dom that ships without rAF — so a late measure
// no-ops safely instead of crashing. INSTALLED ONLY WHEN ABSENT, so a real browser/Playwright run is
// never clobbered (the storybook project doesn't load this setup file; the guard keeps that contract
// explicit). happy-dom 20 already exposes rAF, so this is inert there today — kept for resilience.
export function installRafShim(target: Record<string, unknown>): void {
  if (typeof target.requestAnimationFrame === 'function') return; // a real rAF exists — leave it alone
  target.requestAnimationFrame = (cb: FrameRequestCallback): number =>
    setTimeout(() => cb(typeof performance !== 'undefined' ? performance.now() : Date.now()), 0) as unknown as number;
  target.cancelAnimationFrame = (id: number): void =>
    clearTimeout(id as unknown as ReturnType<typeof setTimeout>);
}

installRafShim(globalThis as unknown as Record<string, unknown>);
if (typeof window !== 'undefined') installRafShim(window as unknown as Record<string, unknown>);
