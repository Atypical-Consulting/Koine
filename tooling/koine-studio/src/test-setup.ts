// Vitest setup (test-only). happy-dom 20.x ships no Web Storage, so modules that persist via
// `localStorage` (store.ts) can't be exercised without a shim. Install a minimal in-memory
// localStorage/sessionStorage on the global. Never bundled into the app — only vitest loads this.

// happy-dom ships no IndexedDB either; the secret store (secrets.ts) needs one. fake-indexeddb/auto
// installs an in-memory IndexedDB on the global. A fresh environment per test file isolates it.
import 'fake-indexeddb/auto';
// Side-effect import, textually BEFORE `preact` below — see the "SYNC RENDERING" section further down
// for why this ordering is load-bearing (it guarantees preact/hooks' own internal `__c` wrapper is
// installed before this file chains onto it).
import 'preact/hooks';
import { webcrypto } from 'node:crypto';
import { options as preactOptions } from 'preact';
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

// happy-dom 20.x's GlobalEventHandlers mixin omits `ondragstart`/`ondragover`/`ondrop`/&c. on
// Element/HTMLElement — it only defines them on `BrowserWindow` (spec-wise they belong on both). Preact's
// DOM-prop -> event-name inference (`lowerCaseName in dom` in preact/src/diff/props.js) uses THEIR
// PRESENCE ON THE TARGET NODE to decide whether to lowercase a JSX `onDragStart`-style prop before calling
// `addEventListener`. Without them, Preact falls back to the *unlowercased* prop remainder ("DragStart"
// instead of "dragstart"), so `<div onDragStart={...}>` silently registers a listener for a native event
// name no browser ever dispatches, and a test's `dispatchEvent(new Event('dragstart'))` never reaches it.
// Defining the properties (mirroring the real HTMLElement.prototype IDL surface) closes the gap —
// ExplorerPanel's drag-and-drop (#989 task 6) is the first place in this codebase to hit it. Installed
// only when absent, so a real browser/Playwright run (the storybook project doesn't load this setup file)
// or a future happy-dom that adds proper support is never clobbered.
const DRAG_EVENT_HANDLER_PROPS = ['ondrag', 'ondragend', 'ondragenter', 'ondragexit', 'ondragleave', 'ondragover', 'ondragstart', 'ondrop'];
if (typeof HTMLElement !== 'undefined') {
  for (const prop of DRAG_EVENT_HANDLER_PROPS) {
    if (!(prop in HTMLElement.prototype)) {
      const handlers = new WeakMap<HTMLElement, unknown>();
      Object.defineProperty(HTMLElement.prototype, prop, {
        configurable: true,
        get(this: HTMLElement) {
          return handlers.get(this) ?? null;
        },
        set(this: HTMLElement, value: unknown) {
          handlers.set(this, value);
        },
      });
    }
  }
}

// SYNC RENDERING (#989 task 8 follow-up — moved here from src/shell/explorer.tsx, which no longer
// patches any Preact internals): explorer.test.ts drives the `createExplorer()` facade the way the
// retired imperative widget always was — a raw `row.click()` / `input.dispatchEvent(...)` /
// `ex.render(...)` / `ex.revealByContext(...)` immediately followed by a DOM assertion, with no `act()`
// wrapper and no awaited tick (that assertion style is pinned; not something this shim gets to change).
// Preact defers a state-driven re-render (`options.debounceRendering`, default: a microtask), so none of
// that would be visible synchronously without help — `installExplorerSyncRendering()` below forces
// `debounceRendering` to run its callback immediately, the same technique `preact/test-utils`'s own
// `act()` uses (temporarily, for the duration of its callback), just installed for the rest of the
// calling test file's run instead. `debounceRendering` is a Preact-internal scheduling seam (not the
// browser's real `requestAnimationFrame`), so this only changes WHEN a re-render commits, not what it
// applies — and being confined to this vitest-only setup file, it never touches the production (Tauri
// desktop / browser-WASM) bundle.
//
// OPT-IN, NOT AUTO-INSTALLED — this is exported rather than run at this file's own top level, unlike
// every other shim above. Every test file in this vitest project loads `test-setup.ts` (it's a
// `setupFiles` entry), so patching `preactOptions` unconditionally here would make EVERY test file's
// Preact rendering synchronous, not just explorer.test.ts's. Tried exactly that first, and it broke two
// unrelated suites that depend on Preact's normal DEFERRED effect timing to model a real async race:
// `inspectorController.test.ts`'s "dispose() synchronously releases every store subscription" tests (a
// panel's `useStore` effect-subscription, normally deferred past the test's synchronous
// init()-then-dispose() with no `await` between them, fired synchronously instead and outlived dispose)
// and `SyntaxTreePanel.test.tsx`'s virtualized-scroll `waitFor` assertion. Neither is an explorer
// regression to chase down — they're a DIFFERENT part of the suite relying on the untouched default
// behavior, which this shim must not disturb. So callers opt in explicitly: only explorer.test.ts calls
// `installExplorerSyncRendering()` (ExplorerPanel.test.tsx already wraps its interactions in `act()` per
// Preact-testing convention, so it needs no help either way).
//
// `useEffect` needs the SAME synchronous-observability treatment (e.g. ExplorerPanel's collapsed-token-
// pruning effect) — but its flush hook, `options.requestAnimationFrame`, CANNOT be forced synchronous the
// same naive way: it fires from `options.diffed`, per component, DURING the recursive diff walk — BEFORE
// `commitRoot()` applies that render's refs and flushes its `useLayoutEffect`s. Calling the queued
// callback immediately there runs `useEffect`s with refs not yet assigned (e.g. ExplorerItem's
// rename-input autofocus would see `renameInputRef.current === null` and silently no-op — caught
// empirically: it broke the F2-then-blur parity tests). So instead this QUEUES the callback and flushes
// the queue from the internal per-commit hook `preact/hooks` itself chains onto for `useLayoutEffect`
// (Preact's build MANGLES this hook's property name to `__c`; the unmangled name in Preact's own source
// is `_commit` — `options._commit` in `preact/src/diff/index.js`, but that literal property is absent on
// the shipped, mangled build this app actually runs, so patching it silently no-ops; verified empirically
// by diffing `node_modules/preact/hooks/dist/hooks.mjs`, whose own chain-the-prior-handler pattern
// targets `__c`). It's called once per `commitRoot()` (render.js's top-level `render()` AND
// component.js's `renderComponent()`, i.e. every synchronous commit) AFTER refs/layout effects settle —
// the same relative ordering a real (deferred) `requestAnimationFrame` callback would see, just
// synchronous instead of a real animation frame later.
//
// ESM ORDERING HAZARD: `preact/hooks` installs its own `__c` wrapper (the one this chains onto) the first
// time ANY module imports it — the code below must observe that BEFORE it reads/chains `__c` itself, or
// the chain silently drops every `useLayoutEffect` flush. `explorer.tsx` used to dodge this by installing
// its patch lazily, from `createExplorer()`'s first call (module-top-level import order wasn't guaranteed
// there). Here the ordering is forced directly instead, via the side-effect `import 'preact/hooks';` at
// the top of THIS file: `test-setup.ts` runs (and fully finishes, imports included) before any test
// file's own module code runs, so by the time `installExplorerSyncRendering()` is actually called from
// explorer.test.ts, `preact/hooks`' own `__c` wrapper is already installed. Verified empirically, not
// just assumed: explorer.test.ts (58 tests) and ExplorerPanel.test.tsx both ran green after this moved
// here, with no F2-then-blur or reveal-effect regressions — the same signals that would resurface if the
// ordering hazard had come back.
//
// `__c` isn't part of Preact's public `Options` type (preact/src/index.d.ts only documents the stable
// seams) — `preact/hooks` itself reaches into the identical property to chain its own `useLayoutEffect`
// flush, so this cast mirrors an already-established internal-API usage, not a novel one.
type InternalPreactOptions = typeof preactOptions & {
  __c?: (vnode: unknown, commitQueue: unknown[]) => void;
};

let explorerSyncRenderingInstalled = false;
export function installExplorerSyncRendering(): void {
  if (explorerSyncRenderingInstalled) return;
  explorerSyncRenderingInstalled = true;

  preactOptions.debounceRendering = (cb: () => void) => cb();

  let pendingEffectFlushes: Array<() => void> = [];
  preactOptions.requestAnimationFrame = (cb: () => void) => {
    pendingEffectFlushes.push(cb);
  };
  const internalPreactOptions = preactOptions as InternalPreactOptions;
  const priorCommit = internalPreactOptions.__c;
  internalPreactOptions.__c = (vnode, commitQueue) => {
    priorCommit?.(vnode, commitQueue);
    while (pendingEffectFlushes.length) {
      const queued = pendingEffectFlushes;
      pendingEffectFlushes = [];
      for (const flush of queued) flush();
    }
  };
}

// scratch: verifying the issue #1486 front-end-only path filter; this PR is closed, never merged.
