// Tests for the Koine Studio Web service worker (public/koine-studio-sw.js, issue #443).
//
// Adapts the proven docs-site Playground SW (website/public/koine-sw.js, #328) to Studio's own Vite
// shell + `_framework/*` WASM bundle. We import the SW's pure helpers + dependency-injected behaviours
// directly: the SW only attaches its event listeners inside a real ServiceWorkerGlobalScope, so
// importing it under vitest is side-effect-free, and the cache logic runs against an in-memory fake
// Cache Storage (no browser needed) — same harness shape as the playground SW test.

import { describe, it, expect } from 'vitest';
import {
  WASM_CACHE_PREFIX,
  SHELL_CACHE_PREFIX,
  shellCacheName,
  shellAssetUrls,
  frameworkPrefixForScope,
  isFrameworkPath,
  isBootManifestPath,
  isLoaderPath,
  isShellAssetPath,
  frameworkBaseOf,
  cacheNameFor,
  parseBootManifest,
  existingCacheName,
  cacheFirst,
  handleAssetRequest,
  handleLoaderRequest,
  handleManifestRequest,
  handleNavigationRequest,
  handleShellAssetRequest,
  staleCacheNames,
  staleShellCacheNames,
  evictStaleCaches,
  evictStaleShellCaches,
  precacheFramework,
  precacheShell,
} from '../../public/koine-studio-sw.js';

// --- in-memory Cache Storage fake ------------------------------------------------------------------

class FakeCache {
  store = new Map<string, Response>();
  async match(req: Request | string): Promise<Response | undefined> {
    const key = typeof req === 'string' ? req : req.url;
    const hit = this.store.get(key);
    return hit ? hit.clone() : undefined;
  }
  async put(req: Request | string, res: Response): Promise<void> {
    this.store.set(typeof req === 'string' ? req : req.url, res);
  }
  async addAll(urls: string[]): Promise<void> {
    for (const u of urls) this.store.set(u, new Response('precached', { status: 200 }));
  }
}
class FakeCaches {
  map = new Map<string, FakeCache>();
  async open(name: string): Promise<FakeCache> {
    let c = this.map.get(name);
    if (!c) this.map.set(name, (c = new FakeCache()));
    return c;
  }
  async keys(): Promise<string[]> {
    return [...this.map.keys()];
  }
  async delete(name: string): Promise<boolean> {
    return this.map.delete(name);
  }
}

// Studio is served at its own Vite base ('/' locally, e.g. '/Koine/studio/' under a sub-path deploy).
const SCOPE = '/studio/';
const FW = `https://x.test${SCOPE}koine-wasm/_framework/`;
const GEN = 'sha256-BOTT8LZFhIOazBby/APiIInxmq1/mROWjUdpbNkgK34=';
const FW_PREFIX = `${SCOPE}koine-wasm/_framework/`;

function manifestText(hash = GEN): string {
  return `export const config = /*json-start*/${JSON.stringify({
    mainAssemblyName: 'Koine.Wasm.dll',
    resources: {
      hash,
      jsModuleNative: [{ name: 'dotnet.native.js' }],
      jsModuleRuntime: [{ name: 'dotnet.runtime.js' }],
      wasmNative: [{ name: 'dotnet.native.wasm', hash: 'sha256-aaa' }],
      coreAssembly: [
        { name: 'Koine.Compiler.wasm', hash: 'sha256-bbb' },
        { name: 'System.Linq.wasm', hash: 'sha256-ccc' },
      ],
      assembly: [],
    },
  })}/*json-end*/;`;
}

describe('koine-studio-sw — pure helpers', () => {
  it('frameworkPrefixForScope anchors at <scope>koine-wasm/_framework/', () => {
    expect(frameworkPrefixForScope('/studio/')).toBe('/studio/koine-wasm/_framework/');
    expect(frameworkPrefixForScope('/')).toBe('/koine-wasm/_framework/');
    expect(frameworkPrefixForScope('/Koine/studio/')).toBe('/Koine/studio/koine-wasm/_framework/');
  });

  it('isFrameworkPath matches Studio framework assets and excludes ordinary nav / built assets', () => {
    expect(isFrameworkPath(`${SCOPE}koine-wasm/_framework/dotnet.js`, FW_PREFIX)).toBe(true);
    expect(isFrameworkPath(`${SCOPE}koine-wasm/_framework/Koine.Compiler.wasm`, FW_PREFIX)).toBe(true);
    expect(isFrameworkPath(`${SCOPE}assets/index-abc123.js`, FW_PREFIX)).toBe(false);
    expect(isFrameworkPath(`${SCOPE}koine-wasm/main.js`, FW_PREFIX)).toBe(false);
    expect(isFrameworkPath(`${SCOPE}`, FW_PREFIX)).toBe(false);
  });

  it('isBootManifestPath / isLoaderPath classify the network-first entries', () => {
    expect(isBootManifestPath(`${SCOPE}koine-wasm/_framework/dotnet.boot.js`)).toBe(true);
    expect(isBootManifestPath(`${SCOPE}koine-wasm/_framework/dotnet.js`)).toBe(false);
    expect(isLoaderPath(`${SCOPE}koine-wasm/_framework/dotnet.js`)).toBe(true);
    expect(isLoaderPath(`${SCOPE}koine-wasm/_framework/dotnet.boot.js`)).toBe(false);
  });

  it('isShellAssetPath matches content-hashed built assets under <scope>assets/', () => {
    expect(isShellAssetPath(`${SCOPE}assets/index-abc123.js`, SCOPE)).toBe(true);
    expect(isShellAssetPath(`${SCOPE}assets/style-def456.css`, SCOPE)).toBe(true);
    expect(isShellAssetPath(`${SCOPE}koine-wasm/_framework/dotnet.js`, SCOPE)).toBe(false);
    expect(isShellAssetPath(`${SCOPE}index.html`, SCOPE)).toBe(false);
  });

  it('frameworkBaseOf returns the path up to and including _framework/', () => {
    expect(frameworkBaseOf(`${FW}Koine.Compiler.wasm`)).toBe(FW);
    expect(frameworkBaseOf(`https://x.test${SCOPE}assets/index.js`)).toBeNull();
  });

  it('cacheNameFor base64url-maps the sha256 hash and is injective (no +//= collision)', () => {
    expect(cacheNameFor(GEN)).toBe(`${WASM_CACHE_PREFIX}sha256-BOTT8LZFhIOazBby_APiIInxmq1_mROWjUdpbNkgK34`);
    expect(cacheNameFor(GEN).startsWith(WASM_CACHE_PREFIX)).toBe(true);
    expect(cacheNameFor('sha256-a+b')).not.toBe(cacheNameFor('sha256-a/b'));
  });

  it('shellCacheName / shellAssetUrls build the base-aware shell precache list (just the document)', () => {
    expect(shellCacheName().startsWith(SHELL_CACHE_PREFIX)).toBe(true);
    const urls = shellAssetUrls('/studio/');
    expect(urls).toContain('/studio/');
    expect(urls).toContain('/studio/index.html');
    // The manifest/icons are NOT precached here — the browser holds its own copies and the fetch
    // handler never serves them, so listing them would be dead work.
    expect(urls).not.toContain('/studio/manifest.webmanifest');
    // base '/' must not produce a doubled slash
    expect(shellAssetUrls('/')).toContain('/index.html');
  });

  it('parseBootManifest extracts resources.hash and the full asset list', () => {
    const { generation, assetUrls } = parseBootManifest(manifestText(), FW);
    expect(generation).toBe(GEN);
    expect(assetUrls).toContain(`${FW}dotnet.js`);
    expect(assetUrls).toContain(`${FW}dotnet.boot.js`);
    expect(assetUrls).toContain(`${FW}dotnet.native.wasm`);
    expect(assetUrls).toContain(`${FW}Koine.Compiler.wasm`);
    expect(assetUrls).toContain(`${FW}System.Linq.wasm`);
  });

  it('parseBootManifest tolerates a manifest without json markers', () => {
    const raw = JSON.stringify({ resources: { hash: 'sha256-zzz', coreAssembly: [{ name: 'A.wasm' }] } });
    const { generation, assetUrls } = parseBootManifest(raw, FW);
    expect(generation).toBe('sha256-zzz');
    expect(assetUrls).toContain(`${FW}A.wasm`);
  });
});

describe('koine-studio-sw — cacheFirst', () => {
  it('returns the cached response without fetching on a hit', async () => {
    const caches = new FakeCaches();
    const cache = await caches.open('c');
    await cache.put(new Request(`${FW}System.Linq.wasm`), new Response('cached'));
    let fetched = false;
    const deps = { caches, fetch: async () => { fetched = true; return new Response('net'); } };

    const res = await cacheFirst(new Request(`${FW}System.Linq.wasm`), 'c', deps);

    expect(await res.text()).toBe('cached');
    expect(fetched).toBe(false);
  });

  it('fetches, stores, and returns on a miss', async () => {
    const caches = new FakeCaches();
    const deps = { caches, fetch: async () => new Response('net', { status: 200 }) };

    const res = await cacheFirst(new Request(`${FW}System.Linq.wasm`), 'c', deps);
    expect(await res.text()).toBe('net');

    const cache = await caches.open('c');
    const stored = await cache.match(new Request(`${FW}System.Linq.wasm`));
    expect(stored).toBeDefined();
    expect(await stored!.text()).toBe('net');
  });

  it('does not cache a non-ok response', async () => {
    const caches = new FakeCaches();
    const deps = { caches, fetch: async () => new Response('nope', { status: 404 }) };

    await cacheFirst(new Request(`${FW}missing.wasm`), 'c', deps);

    const cache = await caches.open('c');
    expect(await cache.match(new Request(`${FW}missing.wasm`))).toBeUndefined();
  });
});

describe('koine-studio-sw — handleAssetRequest (cache-first WASM)', () => {
  it('passes through to the network before any generation cache exists', async () => {
    const caches = new FakeCaches();
    let fetched = false;
    const deps = { caches, fetch: async () => { fetched = true; return new Response('net'); } };

    const res = await handleAssetRequest(new Request(`${FW}Koine.Compiler.wasm`), deps);
    expect(await res.text()).toBe('net');
    expect(fetched).toBe(true);
    expect(await caches.keys()).toHaveLength(0);
  });

  it('cache-first serves a cached _framework/* asset with NO network', async () => {
    const caches = new FakeCaches();
    const cache = await caches.open(cacheNameFor(GEN));
    await cache.put(new Request(`${FW}Koine.Compiler.wasm`), new Response('cached-asm'));
    let fetched = false;
    const deps = { caches, fetch: async () => { fetched = true; return new Response('net'); } };

    const res = await handleAssetRequest(new Request(`${FW}Koine.Compiler.wasm`), deps);
    expect(await res.text()).toBe('cached-asm');
    expect(fetched).toBe(false); // zero network on a cache hit — the offline-compile promise
  });
});

describe('koine-studio-sw — handleLoaderRequest (network-first)', () => {
  it('fetches the loader fresh (even on a cache hit) so it matches the live generation', async () => {
    const caches = new FakeCaches();
    const cache = await caches.open(cacheNameFor(GEN));
    await cache.put(new Request(`${FW}dotnet.js`), new Response('OLD-loader'));
    const deps = { caches, fetch: async () => new Response('NEW-loader', { status: 200 }) };

    const res = await handleLoaderRequest(new Request(`${FW}dotnet.js`), deps);

    expect(await res.text()).toBe('NEW-loader');
    const stored = await cache.match(new Request(`${FW}dotnet.js`));
    expect(await stored!.text()).toBe('NEW-loader');
  });

  it('falls back to the cached loader when offline', async () => {
    const caches = new FakeCaches();
    const cache = await caches.open(cacheNameFor(GEN));
    await cache.put(new Request(`${FW}dotnet.js`), new Response('cached-loader'));
    const deps = { caches, fetch: async () => { throw new Error('offline'); } };

    const res = await handleLoaderRequest(new Request(`${FW}dotnet.js`), deps);
    expect(await res.text()).toBe('cached-loader');
  });
});

describe('koine-studio-sw — handleManifestRequest (network-first + hash-keyed eviction)', () => {
  it('fetches fresh, opens the generation cache, stores the manifest, and returns it', async () => {
    const caches = new FakeCaches();
    const deps = { caches, fetch: async () => new Response(manifestText(), { status: 200 }) };

    const res = await handleManifestRequest(new Request(`${FW}dotnet.boot.js`), FW, deps);
    expect((await res.text()).includes('json-start')).toBe(true);

    expect(await existingCacheName(deps)).toBe(cacheNameFor(GEN));
    const cache = await caches.open(cacheNameFor(GEN));
    expect(await cache.match(new Request(`${FW}dotnet.boot.js`))).toBeDefined();
  });

  it('falls back to the cached manifest when offline', async () => {
    const caches = new FakeCaches();
    const cache = await caches.open(cacheNameFor(GEN));
    await cache.put(new Request(`${FW}dotnet.boot.js`), new Response(manifestText()));
    const deps = { caches, fetch: async () => { throw new Error('offline'); } };

    const res = await handleManifestRequest(new Request(`${FW}dotnet.boot.js`), FW, deps);
    expect((await res.text()).includes('json-start')).toBe(true);
  });

  it('evicts the stale generation cache when the manifest reports a new hash', async () => {
    const caches = new FakeCaches();
    const oldName = cacheNameFor('sha256-OLD');
    await caches.open(oldName);
    const deps = { caches, fetch: async () => new Response(manifestText(GEN), { status: 200 }) };

    await handleManifestRequest(new Request(`${FW}dotnet.boot.js`), FW, deps);

    const names = await caches.keys();
    expect(names).toContain(cacheNameFor(GEN));
    expect(names).not.toContain(oldName);
  });
});

describe('koine-studio-sw — WASM generation eviction (hash-keyed)', () => {
  it('staleCacheNames keeps only the current generation', () => {
    const names = [cacheNameFor('sha256-a'), cacheNameFor('sha256-b'), 'unrelated-cache'];
    expect(staleCacheNames(names, cacheNameFor('sha256-b'))).toEqual([cacheNameFor('sha256-a')]);
  });

  it('evictStaleCaches deletes a stale-hash generation but never the shell or unrelated caches', async () => {
    const caches = new FakeCaches();
    await caches.open(cacheNameFor('sha256-old'));
    await caches.open(cacheNameFor('sha256-new'));
    await caches.open(shellCacheName()); // the shell cache must survive WASM eviction
    await caches.open('starlight-pagefind'); // an unrelated cache must survive
    const deps = { caches, fetch: async () => new Response() };

    const evicted = await evictStaleCaches(cacheNameFor('sha256-new'), deps);

    expect(evicted).toEqual([cacheNameFor('sha256-old')]);
    const names = await caches.keys();
    expect(names).toContain(cacheNameFor('sha256-new'));
    expect(names).toContain(shellCacheName());
    expect(names).toContain('starlight-pagefind');
    expect(names).not.toContain(cacheNameFor('sha256-old'));
  });
});

describe('koine-studio-sw — shell precache + cache-first', () => {
  it('precacheShell warms the base-aware shell asset list into the shell cache', async () => {
    const caches = new FakeCaches();
    const deps = { caches, fetch: async () => new Response('asset', { status: 200 }) };

    await precacheShell('/studio/', deps);

    const cache = await caches.open(shellCacheName());
    expect(await cache.match('/studio/')).toBeDefined();
    expect(await cache.match('/studio/index.html')).toBeDefined();
  });

  it('handleShellAssetRequest is cache-first for content-hashed built assets', async () => {
    const caches = new FakeCaches();
    const cache = await caches.open(shellCacheName());
    await cache.put(new Request(`https://x.test${SCOPE}assets/index-abc.js`), new Response('cached-js'));
    let fetched = false;
    const deps = { caches, fetch: async () => { fetched = true; return new Response('net'); } };

    const res = await handleShellAssetRequest(new Request(`https://x.test${SCOPE}assets/index-abc.js`), deps);
    expect(await res.text()).toBe('cached-js');
    expect(fetched).toBe(false);
  });
});

describe('koine-studio-sw — handleNavigationRequest (network-first shell, offline fallback)', () => {
  it('serves a fresh document from the network and caches it for offline', async () => {
    const caches = new FakeCaches();
    const deps = { caches, fetch: async () => new Response('<!doctype html>NEW', { status: 200 }) };

    const res = await handleNavigationRequest(new Request(`https://x.test${SCOPE}`), '/studio/', deps);
    expect(await res.text()).toBe('<!doctype html>NEW');

    const cache = await caches.open(shellCacheName());
    expect(await cache.match('/studio/index.html')).toBeDefined();
  });

  it('falls back to the cached index.html when offline', async () => {
    const caches = new FakeCaches();
    const cache = await caches.open(shellCacheName());
    await cache.put('/studio/index.html', new Response('<!doctype html>CACHED', { status: 200 }));
    const deps = { caches, fetch: async () => { throw new Error('offline'); } };

    const res = await handleNavigationRequest(new Request(`https://x.test${SCOPE}deep/link`), '/studio/', deps);
    expect(await res.text()).toBe('<!doctype html>CACHED'); // SPA: any route resolves to the cached shell
  });
});

describe('koine-studio-sw — shell-version eviction (activate)', () => {
  it('staleShellCacheNames keeps only the current shell generation', () => {
    const names = ['koine-studio-shell-v1', 'koine-studio-shell-v2', cacheNameFor('sha256-x'), 'unrelated'];
    expect(staleShellCacheNames(names, 'koine-studio-shell-v2')).toEqual(['koine-studio-shell-v1']);
  });

  it('evictStaleShellCaches drops old shell generations but keeps WASM + unrelated caches', async () => {
    const caches = new FakeCaches();
    await caches.open('koine-studio-shell-OLD');
    await caches.open(shellCacheName());
    await caches.open(cacheNameFor(GEN)); // the warmed compiler must survive a shell-version bump
    await caches.open('starlight-pagefind');
    const deps = { caches, fetch: async () => new Response() };

    const evicted = await evictStaleShellCaches(shellCacheName(), deps);

    expect(evicted).toEqual(['koine-studio-shell-OLD']);
    const names = await caches.keys();
    expect(names).toContain(shellCacheName());
    expect(names).toContain(cacheNameFor(GEN));
    expect(names).toContain('starlight-pagefind');
    expect(names).not.toContain('koine-studio-shell-OLD');
  });
});

describe('koine-studio-sw — idle precache', () => {
  it('warms every framework asset into the generation cache and evicts stale ones', async () => {
    const caches = new FakeCaches();
    await caches.open(cacheNameFor('sha256-OLD'));
    const fetched: string[] = [];
    const deps = {
      caches,
      fetch: async (url: string) => {
        if (String(url).endsWith('dotnet.boot.js')) return new Response(manifestText(), { status: 200 });
        fetched.push(String(url));
        return new Response('asset', { status: 200 });
      },
    };

    await precacheFramework(FW, deps);

    const cache = await caches.open(cacheNameFor(GEN));
    expect(await cache.match(`${FW}Koine.Compiler.wasm`)).toBeDefined();
    expect(await cache.match(`${FW}dotnet.native.wasm`)).toBeDefined();
    expect(await cache.match(`${FW}dotnet.js`)).toBeDefined();
    expect(await caches.keys()).not.toContain(cacheNameFor('sha256-OLD'));
  });

  it('is a no-op when offline (manifest fetch fails)', async () => {
    const caches = new FakeCaches();
    const deps = { caches, fetch: async () => { throw new Error('offline'); } };
    await precacheFramework(FW, deps);
    expect(await caches.keys()).toHaveLength(0);
  });

  it('tolerates a 200-but-non-JSON manifest without throwing', async () => {
    const caches = new FakeCaches();
    const deps = { caches, fetch: async () => new Response('<!doctype html>404', { status: 200 }) };
    await precacheFramework(FW, deps);
    expect(await caches.keys()).toHaveLength(0);
  });
});

describe('koine-studio-sw — offline smoke (warm → go offline → still boots + compiles)', () => {
  it('serves the shell and the whole compiler bundle from cache with the network down', async () => {
    const caches = new FakeCaches();
    // 1. Warm online: shell + manifest + every framework asset get cached.
    const online = {
      caches,
      fetch: async (url: string) =>
        String(url).endsWith('dotnet.boot.js')
          ? new Response(manifestText(), { status: 200 })
          : new Response(`net:${url}`, { status: 200 }),
    };
    await precacheShell('/studio/', online);
    await precacheFramework(FW, online);

    // 2. Go offline.
    const offline = { caches, fetch: async () => { throw new Error('offline'); } };

    // The shell document resolves from cache.
    const nav = await handleNavigationRequest(new Request(`https://x.test${SCOPE}`), '/studio/', offline);
    expect((await nav.text()).length).toBeGreaterThan(0);

    // The manifest + loader + every heavy asset serve from cache.
    const manifest = await handleManifestRequest(new Request(`${FW}dotnet.boot.js`), FW, offline);
    expect((await manifest.text()).includes('json-start')).toBe(true);
    const loader = await handleLoaderRequest(new Request(`${FW}dotnet.js`), offline);
    expect(loader.ok).toBe(true);
    for (const name of ['dotnet.native.wasm', 'Koine.Compiler.wasm', 'System.Linq.wasm']) {
      const res = await handleAssetRequest(new Request(`${FW}${name}`), offline);
      expect(res.ok).toBe(true);
    }
  });
});
