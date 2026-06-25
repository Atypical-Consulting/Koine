# Playground wasm bundle caching — boot-manifest shape & cache key (issue #328)

Developer note backing `koine-sw.js` (the service worker) and `sw-register.ts`. It records what the
.NET-wasm SDK actually emits for the Playground runtime, and **why the service worker keys its cache on
the boot manifest's content hash** rather than on fingerprinted asset filenames.

## What the published bundle looks like

`scripts/build-wasm.mjs` publishes `src/Koine.Wasm` and copies its AppBundle into
`public/koine-wasm/_framework/`. Inspecting the **deployed** bundle
(`https://atypical-consulting.github.io/Koine/koine-wasm/_framework/`) on the current net10 wasm SDK:

- **Asset filenames are *not* content-fingerprinted.** They are stable logical names —
  `Koine.Compiler.wasm`, `System.Linq.wasm`, `dotnet.native.wasm`, `dotnet.runtime.js`,
  `Koine.Wasm.wasm`, … — not `Koine.Compiler.<hash>.wasm`. (`WasmFingerprintAssets` is off; the
  `wasmbrowser` console template does not fingerprint by default.)
- **The boot manifest is `_framework/dotnet.boot.js`** (an ES module, not `blazor.boot.json`). It wraps
  JSON between `/*json-start*/` … `/*json-end*/` markers:

  ```js
  export const config = /*json-start*/{
    "mainAssemblyName": "Koine.Wasm.dll",
    "resources": {
      "hash": "sha256-BOTT8LZFhIOazBby/APiIInxmq1/mROWjUdpbNkgK34=",   // ← content hash of the whole set
      "jsModuleNative":  [ { "name": "dotnet.native.js" } ],
      "jsModuleRuntime": [ { "name": "dotnet.runtime.js" } ],
      "wasmNative":      [ { "name": "dotnet.native.wasm", "hash": "sha256-…" } ],
      "coreAssembly":    [ { "name": "Koine.Compiler.wasm", "hash": "sha256-…" }, … ],  // 19 assemblies
      "assembly":        [ … ]                                          // may be empty
    }
  }/*json-end*/;
  ```

  Every asset carries an integrity `hash`, and `resources.hash` is a single SHA-256 **over the whole
  resource set** — it changes iff any asset's content changes.

- The loader the playground worker imports is the **stable, un-hashed `_framework/dotnet.js`**
  (see `koine.worker.ts → dotnetEntryUrl()`); it loads `dotnet.boot.js`, which lists every other asset.

## Decision: key the cache on `resources.hash`, do **not** enable filename fingerprinting

The plan asked us to verify fingerprinting and "enable it if off". It is off — but enabling filename
fingerprinting is **unnecessary and the riskier option here**, so we don't:

- **`resources.hash` is a better generation token than filenames.** It is one content hash over the
  entire bundle, emitted by the SDK already. The SW names its cache `koine-wasm-<resources.hash>`; a new
  build changes the hash ⇒ new cache ⇒ old generation evicted ⇒ no half-old/half-new runtime. Stable
  filenames are fine because invalidation rides on the manifest hash, not the URL.
- **Enabling `WasmFingerprintAssets` is locally unverifiable and could break the loader contract.** The
  wasm build needs CI-only workloads (it does not build on a dev machine here), and the worker +
  `build-wasm.mjs` depend on the **fixed** `dotnet.js` / `dotnet.boot.js` / `main.js` names. Renaming
  assets on an untestable build path risks shipping a broken Playground for no caching benefit the
  manifest hash doesn't already give us.

If the docs-site ever moves off GitHub Pages (where we could set `Cache-Control: immutable`), filename
fingerprinting becomes worth enabling for HTTP-cache friendliness — tracked as an "if/when the host
changes" follow-up, same bucket as Brotli (see the docs note for #328).

## What the service worker keys on (consumed by Tasks 2–3)

- **Generation token:** `config.resources.hash` parsed from `_framework/dotnet.boot.js`. Cache name =
  `koine-wasm-<sanitized hash>`.
- **Precache list:** `dotnet.js` + `dotnet.boot.js` + every `name` under `resources.jsModuleNative`,
  `jsModuleRuntime`, `wasmNative`, `coreAssembly`, `assembly` (all relative to `_framework/`).
- **Manifest fetch is network-first** (so a new generation is detected even when `koine-sw.js` itself is
  byte-identical and no SW update fires), falling back to cache for offline. All other `_framework/*`
  requests are **cache-first** under the current-generation cache.

> Verified against the live deployed manifest rather than a local `npm run build:wasm`, because the wasm
> publish requires the CI-only `wasm-tools`/`wasm-experimental` workloads.

## Verifying it works

**Automated** (`npm test` in `website/`): `koine-sw.test.ts` covers manifest parsing, cache-first
serving, network-first manifest with offline fallback, generation eviction, idle precache, and an
end-to-end offline smoke (warm the cache → drop the network → every framework request still resolves
from cache). `sw-register.test.ts` covers the base-aware URL/scope, idempotent registration, and the
idle-precache message.

**Manual offline smoke** (needs the real wasm bundle, so run it on a deploy preview or after a local
`npm run build:wasm`):

1. Open the Playground (the landing page IDE) and let "loading compiler…" finish — the runtime boots.
2. DevTools → Application → Cache Storage: a `koine-wasm-sha256-…` cache appears, populated with
   `dotnet.boot.js`, `dotnet.js`, `dotnet.native.wasm`, and the assemblies (idle precache warms the
   rest shortly after).
3. DevTools → Network → check **Offline**, then reload. The compiler still boots and compiles `.koi`
   live — served entirely from the cache, zero network.
4. **Invalidation:** ship a new wasm build (new `resources.hash`). On the next online load the SW reads
   the new manifest, opens `koine-wasm-<newhash>`, and the old `koine-wasm-<oldhash>` cache is evicted —
   no half-old/half-new runtime, no manual cache-busting.
