// Service-worker registration + non-blocking "new version — reload" update flow for Koine Studio Web
// (issue #443). Companion to public/koine-studio-sw.js: that worker makes the installed PWA boot and
// compile offline; this module registers it (guarded for browsers without the API, skipped under the
// Tauri desktop shell) and surfaces a dismissible "reload to update" affordance when a new build is
// deployed — so users never get stuck on a stale generation.
//
// Mirrors the shape of pwaInstall.ts (#442): pure, dependency-injected helpers + a DOM-light controller
// the shell wires to its markup, so everything unit-tests under happy-dom without a real ServiceWorker.

import { isTauri } from '@/host';

/** SW script URL + scope for a Vite base (e.g. '/' → '/koine-studio-sw.js'; '/Koine/studio/' → …). */
export function serviceWorkerUrl(base: string | undefined): { url: string; scope: string } {
  const b = base && base.length ? base : '/';
  const scope = b.endsWith('/') ? b : b + '/';
  return { url: `${scope}koine-studio-sw.js`, scope };
}

// --- update detection (pure, injectable) -----------------------------------------------------------

/** The slice of a `ServiceWorker` this module observes; structural so tests pass a fake. */
interface WorkerLike {
  state: string;
  addEventListener(type: 'statechange', listener: () => void): void;
}
/** The slice of a `ServiceWorkerRegistration` this module observes. */
interface RegistrationLike {
  installing: WorkerLike | null;
  addEventListener(type: 'updatefound', listener: () => void): void;
}

/**
 * Wire a registration's update lifecycle to `onUpdateReady`. When a NEW worker reaches `installed`
 * while a controller was ALREADY in charge at registration time (`hadController`), the install is an
 * update (not the first-ever install), so we surface the reload affordance. Pure → unit-tested.
 */
export function watchForUpdates(
  registration: RegistrationLike,
  onUpdateReady: () => void,
  hadController: boolean,
): void {
  registration.addEventListener('updatefound', () => {
    const installing = registration.installing;
    if (!installing) return; // nothing installing (e.g. a redundant updatefound) — ignore
    installing.addEventListener('statechange', () => {
      if (installing.state === 'installed' && hadController) onUpdateReady();
    });
  });
}

// --- update-affordance controller (mirrors createInstallController) --------------------------------

export interface UpdateController {
  /** Mark a new version installed-and-waiting; flips canReload() true and notifies subscribers. */
  markUpdateReady(): void;
  /** Hide the affordance for this session (a new version stays applied; the reminder just stops nagging). */
  dismiss(): void;
  /** True only when an update is ready AND the user hasn't dismissed the affordance this session. */
  canReload(): boolean;
  /** Whether an update has been detected (independent of dismissal). */
  isReady(): boolean;
  /** Subscribe to state changes (ready / dismiss). Returns an unsubscribe fn. */
  subscribe(listener: () => void): () => void;
}

export function createUpdateController(): UpdateController {
  let ready = false;
  let dismissed = false;
  const listeners = new Set<() => void>();
  const notify = (): void => {
    for (const fn of listeners) fn();
  };
  return {
    markUpdateReady() {
      ready = true;
      notify();
    },
    dismiss() {
      dismissed = true;
      notify();
    },
    canReload() {
      return ready && !dismissed;
    },
    isReady() {
      return ready;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

/** The DOM the update affordance drives: the container plus its reload + dismiss buttons. */
export interface UpdateAffordanceDom {
  /** The container toggled visible/hidden as a unit. */
  root: HTMLElement;
  /** The primary "Reload" button — click reloads to pick up the new version. */
  reloadButton: HTMLButtonElement;
  /** The dismiss "×" button — click hides the affordance for the session. */
  dismissButton: HTMLButtonElement;
  /** How to reload (defaults to a full page reload); injectable for tests. */
  reload?: () => void;
}

/**
 * Wire an {@link UpdateController} to its DOM affordance: toggle visibility from `canReload()` and route
 * clicks to reload/dismiss. Returns a disposer that removes every listener. Pure of global lookups so it
 * unit-tests under happy-dom. The markup reuses the install affordance's classes, which already meet the
 * shell's a11y bar (focusable buttons, AA-contrast brand colours).
 */
export function connectUpdateAffordance(controller: UpdateController, dom: UpdateAffordanceDom): () => void {
  const reload = dom.reload ?? ((): void => window.location.reload());
  const sync = (): void => {
    dom.root.hidden = !controller.canReload();
  };
  const onReload = (): void => reload();
  const onDismiss = (): void => controller.dismiss();

  dom.reloadButton.addEventListener('click', onReload);
  dom.dismissButton.addEventListener('click', onDismiss);
  const unsub = controller.subscribe(sync);
  sync(); // reflect the initial (hidden) state immediately

  return () => {
    dom.reloadButton.removeEventListener('click', onReload);
    dom.dismissButton.removeEventListener('click', onDismiss);
    unsub();
  };
}

// --- registration orchestrator ---------------------------------------------------------------------

/** Run `fn` when the browser is idle so precaching never competes with first paint; setTimeout fallback. */
function whenIdle(fn: () => void): void {
  const g = globalThis as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => void };
  if (typeof g.requestIdleCallback === 'function') g.requestIdleCallback(fn, { timeout: 5000 });
  else setTimeout(fn, 2000);
}

/** Once the SW is active, ask it (on idle) to precache the whole framework bundle. Best-effort. */
function scheduleIdlePrecache(nav: { serviceWorker?: { ready?: Promise<{ active?: { postMessage(m: unknown): void } | null }> } }): void {
  const ready = nav.serviceWorker?.ready;
  if (!ready || typeof ready.then !== 'function') return;
  ready
    .then((reg) => whenIdle(() => reg.active?.postMessage({ type: 'precache' })))
    .catch(() => {
      /* ignore — caching is opportunistic */
    });
}

export interface RegisterServiceWorkerDeps {
  /** Navigator to read `serviceWorker` from (defaults to the real one). */
  navigatorRef?: Navigator;
  /** Window to attach the `load` listener to (defaults to the real one). */
  windowRef?: Window;
  /** Document used to decide whether to register now or on `load` (defaults to the real one). */
  documentRef?: Document;
  /** Override the Tauri-shell check (defaults to host.isTauri). */
  isTauriRef?: () => boolean;
  /** The Vite base (defaults to import.meta.env.BASE_URL). */
  base?: string;
  /** Register synchronously instead of waiting for `window.load` (used by tests). */
  startImmediately?: boolean;
  /** Called when a new version is installed-and-waiting (the shell flips its reload affordance). */
  onUpdateReady?: () => void;
}

let registered = false;

/**
 * Register the Studio service worker once, after the page has loaded (so it never competes with first
 * paint or the WASM download). Returns whether registration was attempted: a no-op (false) where the
 * Service Worker API is unavailable (older browsers → app still works online) or inside the Tauri
 * desktop shell (which serves over a custom protocol and needs no SW). Opportunistic: a failed
 * `register()` is swallowed — the app degrades to online-only rather than erroring.
 */
export function registerStudioServiceWorker(deps: RegisterServiceWorkerDeps = {}): boolean {
  if (registered) return false; // once per page
  const nav = deps.navigatorRef ?? (typeof navigator !== 'undefined' ? navigator : undefined);
  const isTauriShell = deps.isTauriRef ?? isTauri;
  if (isTauriShell()) return false; // desktop shell — no SW needed
  if (!nav || !('serviceWorker' in nav)) return false; // unsupported → online-only, no error

  registered = true;
  const swContainer = nav.serviceWorker;
  const { url, scope } = serviceWorkerUrl(
    deps.base ?? (import.meta.env.BASE_URL as string | undefined),
  );
  const onUpdateReady = deps.onUpdateReady ?? ((): void => {});

  const start = (): void => {
    // Capture the controller BEFORE registering: if a SW already controls this page, any worker that
    // installs afterwards is an update (not the first install), so the reload affordance should show.
    const hadController = !!swContainer.controller;
    swContainer
      .register(url, { type: 'module', scope })
      .then((registration) => {
        watchForUpdates(registration as unknown as RegistrationLike, onUpdateReady, hadController);
        scheduleIdlePrecache(nav);
      })
      .catch(() => {
        /* opportunistic — leave the app online-only on failure */
      });
  };

  const doc = deps.documentRef ?? (typeof document !== 'undefined' ? document : undefined);
  const win = deps.windowRef ?? (typeof window !== 'undefined' ? window : undefined);
  if (deps.startImmediately || (doc && doc.readyState === 'complete')) start();
  else if (win) win.addEventListener('load', start, { once: true });
  else start();

  return true;
}
