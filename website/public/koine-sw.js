// Playground wasm-bundle service worker (issue #328).
// See ../src/playground/koine-wasm-caching.md for the boot-manifest shape and the cache-key rationale.
//
// WHAT IT DOES
//   Cache-first serves the Playground's .NET-wasm runtime under <base>/koine-wasm/_framework/* so a
//   repeat visit boots the in-browser compiler with ZERO network, and the Playground works offline once
//   warmed. The cache is named for the bundle generation — config.resources.hash from
//   _framework/dotnet.boot.js — so a new build's manifest opens a fresh cache and the stale generation is
//   evicted: no manual cache-busting, no half-old/half-new runtime. (Asset FILENAMES are not fingerprinted
//   on GitHub Pages — see the dev note — so the manifest's content hash, not the URL, is what invalidates.)
//
// HOW REQUESTS ARE HANDLED
//   - dotnet.boot.js (the manifest): NETWORK-FIRST — re-read every boot to detect a new generation even
//     when this SW file is byte-identical (so no SW update fires); falls back to the cached copy offline.
//     It is the only request that creates/refreshes the generation cache.
//   - every other _framework/* asset: CACHE-FIRST under the current generation cache.
//   - everything else: PASSES THROUGH untouched — the SW never shadows Starlight navigation / SSR.
//
// Served from public/ at <base>/koine-sw.js so its default scope (<base>/) covers the Playground; the
// dedicated playground worker's _framework/* fetches are in scope and so are intercepted. Registered
// (base-aware) by ../src/playground/sw-register.ts.
//
// Authored as an ES module so the pure helpers below are unit-tested by koine-sw.test.ts. The event
// listeners attach only inside a real ServiceWorkerGlobalScope, so importing this file under vitest is
// side-effect-free.

export const CACHE_PREFIX = 'koine-wasm-';
const FRAMEWORK_MARKER = '/koine-wasm/_framework/';
const MANIFEST_NAME = 'dotnet.boot.js';
const LOADER_NAME = 'dotnet.js';

// --- pure helpers (unit-tested) --------------------------------------------------------------------

/** True for any request under <base>/koine-wasm/_framework/. Base-agnostic — scope already bounds it. */
export function isFrameworkPath(pathname) {
  return pathname.includes(FRAMEWORK_MARKER);
}

/** True for the boot manifest specifically (handled network-first to detect new generations). */
export function isBootManifestPath(pathname) {
  return pathname.endsWith(FRAMEWORK_MARKER + MANIFEST_NAME);
}

/** Absolute framework base (…/koine-wasm/_framework/) for a request URL under it, else null. */
export function frameworkBaseOf(url) {
  const i = url.indexOf(FRAMEWORK_MARKER);
  return i >= 0 ? url.slice(0, i + FRAMEWORK_MARKER.length) : null;
}

/** Cache name for a bundle generation. Sanitises the `sha256-…` hash to a safe cache key. */
export function cacheNameFor(generation) {
  return CACHE_PREFIX + String(generation).replace(/[^A-Za-z0-9_-]/g, '');
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

/** The current generation cache's name (the single koine-wasm-* cache), or null before one exists. */
export async function existingCacheName(deps) {
  const names = await deps.caches.keys();
  return names.find((name) => name.startsWith(CACHE_PREFIX)) ?? null;
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

/** Cache-first for a framework asset under the current generation cache (network passthrough if none). */
export async function handleAssetRequest(request, deps) {
  const cacheName = await existingCacheName(deps);
  if (!cacheName) return deps.fetch(request); // cold start, before the manifest created a cache
  return cacheFirst(request, cacheName, deps);
}

/**
 * Network-first for the manifest: fetch fresh to learn the live generation, (re)populate that
 * generation's cache, return the fresh response. Offline → serve the cached manifest.
 */
export async function handleManifestRequest(request, frameworkBase, deps) {
  try {
    const response = await deps.fetch(request);
    if (response && response.ok) {
      const { generation } = parseBootManifest(await response.clone().text(), frameworkBase);
      if (generation) {
        const cache = await deps.caches.open(cacheNameFor(generation));
        try {
          await cache.put(request, response.clone());
        } catch {
          /* ignore — the live response is still returned below */
        }
      }
      return response;
    }
  } catch {
    /* offline — fall through to the cached manifest */
  }
  const cacheName = await existingCacheName(deps);
  if (cacheName) {
    const cache = await deps.caches.open(cacheName);
    const hit = await cache.match(request);
    if (hit) return hit;
  }
  return deps.fetch(request); // last resort (rejects offline, but a warmed boot never reaches here)
}

// --- service-worker event wiring (attaches only inside a real ServiceWorkerGlobalScope) -------------

if (
  typeof self !== 'undefined' &&
  typeof self.skipWaiting === 'function' &&
  typeof self.addEventListener === 'function'
) {
  const deps = { caches: self.caches, fetch: (...args) => self.fetch(...args) };

  // Take control as soon as possible so even the first visit's later fetches are intercepted.
  self.addEventListener('install', () => self.skipWaiting());
  self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

  self.addEventListener('fetch', (event) => {
    const request = event.request;
    if (request.method !== 'GET') return; // pass through
    const url = new URL(request.url);
    if (!isFrameworkPath(url.pathname)) return; // pass through — don't shadow Starlight navigation
    if (isBootManifestPath(url.pathname)) {
      event.respondWith(handleManifestRequest(request, frameworkBaseOf(request.url), deps));
    } else {
      event.respondWith(handleAssetRequest(request, deps));
    }
  });
}
