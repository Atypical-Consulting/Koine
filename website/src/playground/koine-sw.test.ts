// Tests for the Playground wasm-bundle service worker (public/koine-sw.js, issue #328).
//
// We import the SW's pure helpers + dependency-injected behaviours directly. The SW only attaches its
// event listeners inside a real ServiceWorkerGlobalScope, so importing it under vitest is side-effect-
// free, and we exercise the cache logic against an in-memory fake Cache Storage (no browser needed).

import { describe, it, expect } from 'vitest';
import {
  CACHE_PREFIX,
  isFrameworkPath,
  isBootManifestPath,
  frameworkBaseOf,
  cacheNameFor,
  parseBootManifest,
  existingCacheName,
  cacheFirst,
  handleAssetRequest,
  handleManifestRequest,
} from '../../public/koine-sw.js';

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

const FW = 'https://x.test/Koine/koine-wasm/_framework/';
const GEN = 'sha256-BOTT8LZFhIOazBby/APiIInxmq1/mROWjUdpbNkgK34=';

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

describe('koine-sw — pure helpers', () => {
  it('isFrameworkPath matches only the _framework path', () => {
    expect(isFrameworkPath('/Koine/koine-wasm/_framework/dotnet.js')).toBe(true);
    expect(isFrameworkPath('/koine-wasm/_framework/System.Linq.wasm')).toBe(true);
    expect(isFrameworkPath('/Koine/docs/guide/')).toBe(false);
    expect(isFrameworkPath('/Koine/koine-wasm/main.js')).toBe(false);
  });

  it('isBootManifestPath matches the manifest only', () => {
    expect(isBootManifestPath('/Koine/koine-wasm/_framework/dotnet.boot.js')).toBe(true);
    expect(isBootManifestPath('/Koine/koine-wasm/_framework/dotnet.js')).toBe(false);
  });

  it('frameworkBaseOf returns the path up to and including _framework/', () => {
    expect(frameworkBaseOf(`${FW}Koine.Compiler.wasm`)).toBe(FW);
    expect(frameworkBaseOf('https://x.test/Koine/docs/')).toBeNull();
  });

  it('cacheNameFor sanitises the sha256 hash to a safe cache key', () => {
    expect(cacheNameFor(GEN)).toBe(`${CACHE_PREFIX}sha256-BOTT8LZFhIOazBbyAPiIInxmq1mROWjUdpbNkgK34`);
    expect(cacheNameFor(GEN).startsWith(CACHE_PREFIX)).toBe(true);
  });

  it('parseBootManifest extracts resources.hash and the full asset list', () => {
    const { generation, assetUrls } = parseBootManifest(manifestText(), FW);
    expect(generation).toBe(GEN);
    expect(assetUrls).toContain(`${FW}dotnet.js`); // loader (not in the manifest lists)
    expect(assetUrls).toContain(`${FW}dotnet.boot.js`); // manifest itself
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

describe('koine-sw — cacheFirst', () => {
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

describe('koine-sw — handleAssetRequest', () => {
  it('passes through to the network before any generation cache exists', async () => {
    const caches = new FakeCaches();
    let fetched = false;
    const deps = { caches, fetch: async () => { fetched = true; return new Response('net'); } };

    const res = await handleAssetRequest(new Request(`${FW}dotnet.js`), deps);
    expect(await res.text()).toBe('net');
    expect(fetched).toBe(true);
    expect(await caches.keys()).toHaveLength(0); // nothing cached without a generation cache
  });

  it('cache-first serves from the existing generation cache', async () => {
    const caches = new FakeCaches();
    const cache = await caches.open(cacheNameFor(GEN));
    await cache.put(new Request(`${FW}Koine.Compiler.wasm`), new Response('cached-asm'));
    const deps = { caches, fetch: async () => new Response('net') };

    const res = await handleAssetRequest(new Request(`${FW}Koine.Compiler.wasm`), deps);
    expect(await res.text()).toBe('cached-asm');
  });
});

describe('koine-sw — handleManifestRequest (network-first)', () => {
  it('fetches fresh, opens the generation cache, stores the manifest, and returns it', async () => {
    const caches = new FakeCaches();
    const deps = { caches, fetch: async () => new Response(manifestText(), { status: 200 }) };

    const res = await handleManifestRequest(new Request(`${FW}dotnet.boot.js`), FW, deps);
    expect((await res.text()).includes('json-start')).toBe(true);

    expect(await existingCacheName(deps)).toBe(cacheNameFor(GEN)); // gen cache created
    const cache = await caches.open(cacheNameFor(GEN));
    expect(await cache.match(new Request(`${FW}dotnet.boot.js`))).toBeDefined(); // manifest cached
  });

  it('falls back to the cached manifest when offline', async () => {
    const caches = new FakeCaches();
    const cache = await caches.open(cacheNameFor(GEN));
    await cache.put(new Request(`${FW}dotnet.boot.js`), new Response(manifestText()));
    const deps = { caches, fetch: async () => { throw new Error('offline'); } };

    const res = await handleManifestRequest(new Request(`${FW}dotnet.boot.js`), FW, deps);
    expect((await res.text()).includes('json-start')).toBe(true);
  });
});
