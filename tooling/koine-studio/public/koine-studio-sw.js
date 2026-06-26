// Koine Studio Web service worker (issue #443) — true offline support for the installed PWA.
// Adapts the proven docs-site Playground SW (website/public/koine-sw.js, issue #328) to Studio's own
// Vite app shell + `_framework/*` WASM compiler bundle.
//
// WHAT IT DOES
//   Studio compiles `.koi` entirely in the browser via a multi-megabyte Blazor-WASM bundle (the .NET
//   runtime + the rooted Koine.Compiler/ANTLR assemblies under <base>koine-wasm/_framework/*). This
//   worker makes the installed Studio launch and compile with ZERO network once warmed:
//     • APP SHELL (index.html + content-hashed assets/*, manifest, icons) — cached so the IDE boots
//       offline.
//     • WASM COMPILER (_framework/*) — cache-first by content-hashed generation so a repeat visit boots
//       the compiler with no network.
//
// HOW REQUESTS ARE HANDLED (see the fetch listener at the bottom)
//   - Navigations (the SPA document): NETWORK-FIRST → cache the fresh index.html, fall back to the
//     cached shell offline. Network-first (not cache-first) is what prevents the classic PWA
//     permanent-staleness trap: a new deploy's index.html (which references new content-hashed chunks)
//     is picked up the moment the user is online, while offline still resolves any route to the cached
//     shell. This mirrors #328's network-first manifest/loader rationale, applied to the document.
//   - Built static assets (<base>assets/* — Vite's content-hashed JS/CSS/fonts): CACHE-FIRST. They are
//     immutable by name, so a new build emits new names and old ones simply orphan (pruned on a
//     shell-version bump at activate).
//   - WASM dotnet.boot.js (the manifest): NETWORK-FIRST — re-read every boot to detect a new generation
//     even when this SW file is byte-identical; (re)populates the generation cache and evicts stale
//     ones; falls back to the cached copy offline.
//   - WASM dotnet.js (the loader): NETWORK-FIRST — imported before the manifest, so a cache-first
//     loader could be served from a stale generation after a new build (a half-old/half-new runtime).
//     Small; falls back to the cached loader offline.
//   - every other _framework/* asset: CACHE-FIRST under the current generation cache.
//   - everything else (same-origin out-of-scope, cross-origin): PASSES THROUGH untouched.
//
// CACHE VERSIONING
//   - The WASM bundle is keyed on `config.resources.hash` from dotnet.boot.js (one content hash over the
//     whole bundle — see website/src/playground/koine-wasm-caching.md). A new build ⇒ new hash ⇒ new
//     cache generation ⇒ the stale generation is evicted (on the manifest re-read). No half-old/half-new
//     runtime, no manual cache-busting.
//   - The shell/static cache is named for SHELL_VERSION; `activate` evicts older shell generations.
//
// Served from public/ at <base>koine-studio-sw.js; registered (base-aware) by src/shell/registerServiceWorker.ts.
// The fetch handler anchors on this SW's own registration scope, so when Studio is deployed UNDER the
// docs site at /Koine/studio/ it handles /Koine/studio/koine-wasm/_framework/* — disjoint from the
// Playground SW (scope /Koine/, which deliberately excludes /studio/ per #328).
//
// Authored as an ES module so the pure helpers below are unit-tested by src/shell/koine-studio-sw.test.ts.
// The event listeners attach only inside a real ServiceWorkerGlobalScope, so importing this file under
// vitest is side-effect-free.

export const WASM_CACHE_PREFIX = 'koine-studio-wasm-';
export const SHELL_CACHE_PREFIX = 'koine-studio-shell-';
// Bump SHELL_VERSION to force a one-time eviction of the previous shell/static generation at activate.
// Day-to-day freshness rides on network-first navigations (see header), so this rarely needs touching.
const SHELL_VERSION = 'v1';

const FRAMEWORK_MARKER = '/koine-wasm/_framework/';
const MANIFEST_NAME = 'dotnet.boot.js';
const LOADER_NAME = 'dotnet.js';
const ASSETS_SEGMENT = 'assets/';

// --- pure helpers (unit-tested) --------------------------------------------------------------------

/** The shell/static cache name for the current SHELL_VERSION. */
export function shellCacheName() {
  return SHELL_CACHE_PREFIX + SHELL_VERSION;
}

/**
 * The stable (non-fingerprinted) shell URLs to precache at install so the IDE boots offline:
 * the base document, index.html, the PWA manifest, and the launcher icons. The content-hashed JS/CSS
 * chunks index.html references are cached on demand (cache-first) — their names aren't known here.
 */
export function shellAssetUrls(scope) {
  const b = scope.endsWith('/') ? scope : scope + '/';
  return [
    b,
    `${b}index.html`,
    `${b}manifest.webmanifest`,
    `${b}icons/icon-192.png`,
    `${b}icons/icon-512.png`,
    `${b}icons/icon-512-maskable.png`,
  ];
}

/**
 * Studio's framework path prefix for a SW scope (`new URL(registration.scope).pathname`), anchored at
 * `<scope>koine-wasm/_framework/`. Studio's SW is registered AT its own base, so this matches Studio's
 * own bundle (unlike the Playground SW, which anchors at the site root to exclude /studio/).
 */
export function frameworkPrefixForScope(scopePath) {
  return `${scopePath.replace(/\/$/, '')}/koine-wasm/_framework/`;
}

/** True for a request under Studio's framework prefix. */
export function isFrameworkPath(pathname, frameworkPrefix) {
  return pathname.startsWith(frameworkPrefix);
}

/** True for the boot manifest specifically (handled network-first to detect new generations). */
export function isBootManifestPath(pathname) {
  return pathname.endsWith(FRAMEWORK_MARKER + MANIFEST_NAME);
}

/** True for the loader entry (handled network-first so it always matches the live generation). */
export function isLoaderPath(pathname) {
  return pathname.endsWith(FRAMEWORK_MARKER + LOADER_NAME);
}

/** True for a Vite content-hashed built asset under `<scope>assets/` (cache-first, immutable by name). */
export function isShellAssetPath(pathname, scopePath) {
  const b = scopePath.endsWith('/') ? scopePath : scopePath + '/';
  return pathname.startsWith(b + ASSETS_SEGMENT);
}

/** Absolute framework base (…/koine-wasm/_framework/) for a request URL under it, else null. */
export function frameworkBaseOf(url) {
  const i = url.indexOf(FRAMEWORK_MARKER);
  return i >= 0 ? url.slice(0, i + FRAMEWORK_MARKER.length) : null;
}

/**
 * Cache name for a WASM bundle generation. base64url-maps the `sha256-…` hash (`+`→`-`, `/`→`_`, drop
 * padding) so it is a safe cache key AND injective — distinct hashes never collapse to one name.
 */
export function cacheNameFor(generation) {
  const safe = String(generation).replace(/\+/g, '-').replace(/\//g, '_').replace(/[^A-Za-z0-9_-]/g, '');
  return WASM_CACHE_PREFIX + safe;
}

/**
 * Parse _framework/dotnet.boot.js → { generation, assetUrls }.
 *   generation: config.resources.hash — one content hash over the whole bundle.
 *   assetUrls:  every framework file worth precaching, absolute (frameworkBase + name): the loader
 *               (dotnet.js) + the manifest (dotnet.boot.js) + every `name` under the resources.* lists.
 * The manifest wraps its JSON between /*json-start* / … /*json-end* / markers; tolerate their absence.
 */
export function parseBootManifest(text, frameworkBase) {
  const open = text.indexOf('/*json-start*/');
  const close = text.lastIndexOf('/*json-end*/');
  const json = open >= 0 && close >= 0 ? text.slice(open + '/*json-start*/'.length, close) : text;
  const config = JSON.parse(json);
  const resources = config.resources ?? {};
  const names = new Set([LOADER_NAME, MANIFEST_NAME]);
  for (const value of Object.values(resources)) {
    if (Array.isArray(value)) {
      for (const asset of value) if (asset && asset.name) names.add(asset.name);
    }
  }
  return {
    generation: resources.hash ?? null,
    assetUrls: [...names].map((name) => frameworkBase + name),
  };
}

// --- behaviours (dependency-injected via `deps = { caches, fetch }` so they unit-test) --------------

/** The current WASM generation cache's name (the single koine-studio-wasm-* cache), or null. */
export async function existingCacheName(deps) {
  const names = await deps.caches.keys();
  return names.find((name) => name.startsWith(WASM_CACHE_PREFIX)) ?? null;
}

/** Cache-first: serve from `cacheName`; on miss fetch, store a clone, return. Never caches !ok. */
export async function cacheFirst(request, cacheName, deps) {
  const cache = await deps.caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await deps.fetch(request);
  if (response && response.ok) {
    try {
      await cache.put(request, response.clone());
    } catch {
      /* opaque/aborted body — still serve the live response */
    }
  }
  return response;
}

/** Serve `request` from the current WASM generation cache, or null when it isn't cached. */
async function matchInCurrentCache(request, deps) {
  const cacheName = await existingCacheName(deps);
  if (!cacheName) return null;
  const cache = await deps.caches.open(cacheName);
  return (await cache.match(request)) ?? null;
}

/** Cache-first for a framework asset under the current generation cache (network passthrough if none). */
export async function handleAssetRequest(request, deps) {
  const cacheName = await existingCacheName(deps);
  if (!cacheName) return deps.fetch(request); // cold start, before the manifest created a cache
  return cacheFirst(request, cacheName, deps);
}

/** Cache-first for a content-hashed built asset under the shell cache (network passthrough otherwise). */
export async function handleShellAssetRequest(request, deps) {
  return cacheFirst(request, shellCacheName(), deps);
}

/**
 * Network-first for the loader (`dotnet.js`). The worker imports it BEFORE the manifest is fetched, so
 * a cache-first loader could be served from a STALE generation cache after a new build, then read the
 * new manifest — a half-old/half-new runtime. Fetching it fresh keeps it matched to the live build (the
 * heavy hashed assets stay cache-first — the loader is small). Offline → serve the cached loader.
 */
export async function handleLoaderRequest(request, deps) {
  try {
    const response = await deps.fetch(request);
    if (response && response.ok) {
      const cacheName = await existingCacheName(deps);
      if (cacheName) {
        const cache = await deps.caches.open(cacheName);
        try {
          await cache.put(request, response.clone());
        } catch {
          /* ignore — the live response is still returned */
        }
      }
      return response;
    }
  } catch {
    /* offline — fall through to the cached loader */
  }
  return (await matchInCurrentCache(request, deps)) ?? deps.fetch(request);
}

/**
 * Network-first for the manifest: fetch fresh to learn the live generation, (re)populate that
 * generation's cache, evict stale generations, return the fresh response. Offline → cached manifest.
 */
export async function handleManifestRequest(request, frameworkBase, deps) {
  try {
    const response = await deps.fetch(request);
    if (response && response.ok) {
      const { generation } = parseBootManifest(await response.clone().text(), frameworkBase);
      if (generation) {
        const cacheName = cacheNameFor(generation);
        const cache = await deps.caches.open(cacheName);
        try {
          await cache.put(request, response.clone());
        } catch {
          /* ignore — the live response is still returned below */
        }
        // A new build ⇒ new resources.hash ⇒ new cache name ⇒ evict the stale generation(s) here, on
        // the manifest re-read every boot does. (Eviction can't wait for `activate`: a byte-identical
        // koine-studio-sw.js never re-installs, so a bundle-only change would otherwise never clean up.)
        await evictStaleCaches(cacheName, deps);
      }
      return response;
    }
  } catch {
    /* offline — fall through to the cached manifest */
  }
  return (await matchInCurrentCache(request, deps)) ?? deps.fetch(request);
}

/**
 * Network-first for SPA navigations. Fetch the document fresh and refresh the cached shell (so a new
 * deploy is picked up online and offline reloads stay current); offline → serve the cached index.html
 * (any route resolves to the single-page shell). This is the offline-launch guarantee for the app shell.
 */
export async function handleNavigationRequest(request, scopePath, deps) {
  const b = scopePath.endsWith('/') ? scopePath : scopePath + '/';
  const indexUrl = `${b}index.html`;
  try {
    const response = await deps.fetch(request);
    if (response && response.ok) {
      try {
        const cache = await deps.caches.open(shellCacheName());
        await cache.put(indexUrl, response.clone());
      } catch {
        /* ignore — the live response is still returned */
      }
      return response;
    }
  } catch {
    /* offline — fall through to the cached shell */
  }
  const cache = await deps.caches.open(shellCacheName());
  return (await cache.match(indexUrl)) ?? (await cache.match(b)) ?? deps.fetch(request);
}

/** Names of stale koine-studio-wasm-* caches (all ours except the current generation's) to delete. */
export function staleCacheNames(existingNames, currentName) {
  return existingNames.filter((name) => name.startsWith(WASM_CACHE_PREFIX) && name !== currentName);
}

/** Delete every koine-studio-wasm-* cache except `currentCacheName`. Returns the evicted names. */
export async function evictStaleCaches(currentCacheName, deps) {
  const stale = staleCacheNames(await deps.caches.keys(), currentCacheName);
  await Promise.all(stale.map((name) => deps.caches.delete(name)));
  return stale;
}

/** Names of stale koine-studio-shell-* caches (older shell generations) to delete. */
export function staleShellCacheNames(existingNames, currentShellName) {
  return existingNames.filter((name) => name.startsWith(SHELL_CACHE_PREFIX) && name !== currentShellName);
}

/**
 * Delete every koine-studio-shell-* cache except `currentShellName`. Called at `activate` so a
 * SHELL_VERSION bump cleans up the previous shell generation — without ever touching the warmed WASM
 * caches (a different prefix) or any unrelated cache. Returns the evicted names.
 */
export async function evictStaleShellCaches(currentShellName, deps) {
  const stale = staleShellCacheNames(await deps.caches.keys(), currentShellName);
  await Promise.all(stale.map((name) => deps.caches.delete(name)));
  return stale;
}

/** Precache the stable shell URLs into the shell cache so the IDE boots offline. Best-effort. */
export async function precacheShell(scopePath, deps) {
  const cache = await deps.caches.open(shellCacheName());
  await Promise.all(
    shellAssetUrls(scopePath).map(async (url) => {
      try {
        const res = await deps.fetch(url);
        if (res && res.ok) await cache.put(url, res.clone());
      } catch {
        /* best-effort — a missing shell URL must not fail install */
      }
    }),
  );
}

/**
 * Idle warm: precache the whole framework bundle into the current generation cache so the *next*
 * navigation is a pure cache hit (without blocking first paint — scheduled on idle by the registrar).
 * Reads the manifest for the generation + asset list, fetches anything not already cached, then evicts
 * stale generations. Best-effort: a failed asset is skipped, and offline is a no-op.
 */
export async function precacheFramework(frameworkBase, deps) {
  let generation;
  let assetUrls;
  try {
    const res = await deps.fetch(frameworkBase + MANIFEST_NAME, { cache: 'no-store' });
    if (!res || !res.ok) return;
    // Parse inside the try: a 200-but-non-JSON manifest (a host 404/redirect HTML page) must not throw
    // an unhandled rejection out of the message handler's waitUntil — just skip warming.
    ({ generation, assetUrls } = parseBootManifest(await res.text(), frameworkBase));
  } catch {
    return; // offline, or a non-JSON manifest — nothing to warm
  }
  if (!generation) return;
  const cacheName = cacheNameFor(generation);
  const cache = await deps.caches.open(cacheName);
  await Promise.all(
    assetUrls.map(async (url) => {
      if (await cache.match(url)) return; // already warm
      try {
        const res = await deps.fetch(url);
        if (res && res.ok) await cache.put(url, res.clone());
      } catch {
        /* best-effort — skip this asset */
      }
    }),
  );
  await evictStaleCaches(cacheName, deps);
}

// --- service-worker event wiring (attaches only inside a real ServiceWorkerGlobalScope) -------------

if (
  typeof self !== 'undefined' &&
  typeof self.skipWaiting === 'function' &&
  typeof self.addEventListener === 'function'
) {
  const deps = { caches: self.caches, fetch: (...args) => self.fetch(...args) };
  const scopePath = new URL(self.registration.scope).pathname;
  const frameworkPrefix = frameworkPrefixForScope(scopePath);

  // Precache the app shell at install so the very next offline launch boots. Take control ASAP so even
  // the first visit's later fetches are intercepted.
  self.addEventListener('install', (event) => {
    event.waitUntil(precacheShell(scopePath, deps).then(() => self.skipWaiting()));
  });
  self.addEventListener('activate', (event) => {
    // Evict superseded shell generations (a SHELL_VERSION bump), then claim open clients.
    event.waitUntil(evictStaleShellCaches(shellCacheName(), deps).then(() => self.clients.claim()));
  });

  // Idle precache: the registrar posts { type: 'precache' } once warm, so the next navigation is a pure
  // cache hit. The framework base is Studio's own framework prefix (origin-qualified).
  self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'precache') {
      event.waitUntil(precacheFramework(self.registration.scope.replace(/\/$/, '') + '/koine-wasm/_framework/', deps));
    }
  });

  self.addEventListener('fetch', (event) => {
    const request = event.request;
    if (request.method !== 'GET') return; // pass through
    // SPA navigations → network-first shell (offline fallback to the cached document).
    if (request.mode === 'navigate') {
      event.respondWith(handleNavigationRequest(request, scopePath, deps));
      return;
    }
    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return; // never shadow cross-origin requests
    if (isFrameworkPath(url.pathname, frameworkPrefix)) {
      if (isBootManifestPath(url.pathname)) {
        event.respondWith(handleManifestRequest(request, frameworkBaseOf(request.url), deps));
      } else if (isLoaderPath(url.pathname)) {
        event.respondWith(handleLoaderRequest(request, deps));
      } else {
        event.respondWith(handleAssetRequest(request, deps));
      }
    } else if (isShellAssetPath(url.pathname, scopePath)) {
      event.respondWith(handleShellAssetRequest(request, deps));
    }
    // everything else → pass through to the network untouched
  });
}
