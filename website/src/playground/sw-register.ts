// Registers the Playground wasm-bundle service worker (public/koine-sw.js), base-path aware.
//
// The SW (issue #328) cache-first serves <base>/koine-wasm/_framework/* for instant repeat loads +
// offline. It must be registered with a URL and scope under Astro's base (`/Koine/`) so its default
// scope covers the Playground and the dedicated worker's framework fetches — mirroring the
// `import.meta.env.BASE_URL` handling in koine.worker.ts (`dotnetEntryUrl()`).
//
// Idempotent: safe to call from every mountPlayground() (the landing page can mount more than one IDE).

let registered = false;

/** SW script URL + scope for an Astro base (e.g. '/Koine/' → '/Koine/koine-sw.js', scope '/Koine/'). */
export function serviceWorkerUrls(base: string | undefined): { url: string; scope: string } {
  const b = (base ?? '/').replace(/\/$/, '');
  return { url: `${b}/koine-sw.js`, scope: `${b}/` };
}

/** Run `fn` when the browser is idle (so precaching never competes with first paint); setTimeout fallback. */
function whenIdle(fn: () => void): void {
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => void })
    .requestIdleCallback;
  if (typeof ric === 'function') ric(fn, { timeout: 5000 });
  else setTimeout(fn, 2000);
}

/**
 * Once the SW is active, ask it (on idle) to precache the whole framework bundle so the *second*
 * navigation is a pure cache hit. Best-effort: never throws, never blocks.
 */
export function scheduleIdlePrecache(): void {
  navigator.serviceWorker.ready
    .then((reg) => whenIdle(() => reg.active?.postMessage({ type: 'precache' })))
    .catch(() => {
      /* ignore — caching is opportunistic */
    });
}

/**
 * Register the Playground service worker once, after the page has loaded (so it never competes with
 * first paint or the wasm download). No-op where service workers are unavailable.
 */
export function registerPlaygroundServiceWorker(): void {
  if (registered) return;
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  registered = true;

  const { url, scope } = serviceWorkerUrls(import.meta.env.BASE_URL);
  const register = (): void => {
    navigator.serviceWorker.register(url, { type: 'module', scope }).catch(() => {
      registered = false; // let a later mount retry if this attempt failed
    });
    scheduleIdlePrecache(); // warm the cache on idle so the next visit is instant + offline-ready
  };

  if (typeof document !== 'undefined' && document.readyState === 'complete') {
    register();
  } else if (typeof window !== 'undefined') {
    window.addEventListener('load', register, { once: true });
  } else {
    register();
  }
}
