// Real-browser OFFLINE smoke-test for the Studio service worker (issue #521, following on #443/#517).
//
// Why this exists: koine-studio-sw.js is unit-tested against an in-memory FAKE Cache Storage
// (src/shell/koine-studio-sw.test.ts, src/shell/serviceWorkerUpdate.test.ts) and the `studio (web)` CI
// job's own boot smoke-test (scripts/smoke-boot.mjs, issue #357) deliberately MOCKS the compiler
// worker — so nothing in CI exercises the REAL registered service worker: that it intercepts
// `_framework/*` fetches, actually populates the browser's real Cache Storage, and serves the app
// shell + WASM compiler with the network down. A registration-scope mistake, a fetch-routing bug, or a
// Cache Storage quirk the fake can't model would pass every existing gate and still fail to go offline
// in production — the same shape of gap #357 already closed once for the worker boot itself.
//
// What this script does, against the built `dist/` (mirrors scripts/smoke-boot.mjs's static server):
//   1. load Studio's editor route ONLINE and wait for the compiler worker to boot + compile once
//      (same signal scripts/smoke-boot.mjs uses — proves the app itself still works);
//   2. confirm the service worker reached `active` and is controlling the page;
//   3. force the idle-scheduled `precache` message (serviceWorkerUpdate.ts's `scheduleCompilerPrecache`,
//      normally scheduled via `requestIdleCallback`) to fire immediately — a determinism aid, not a
//      change to what's exercised — then wait for the real Cache Storage to actually hold the loader,
//      the manifest, and the framework assets;
//   4. confirm the app shell (index.html) is cached too, then reload ONCE MORE while still online — a
//      repeat visit, needed because the shell's entry JS/CSS chunks are only cache-first-handled once
//      the SW already controls the requesting page (issue #1685, filed from this test's first real
//      run — see the inline comment at that reload for the full story) — and confirm the entry chunk(s)
//      are now cached too;
//   5. flip the browser context OFFLINE (`page.context().setOffline(true)`) and reload;
//   6. assert the IDE still boots and a `.koi` still compiles — same verdict as step 1 — with the
//      network cut, i.e. served entirely from the Cache Storage the SW populated in steps 1-4.
//
// Any of: a bad registration scope, a fetch handler that doesn't actually cache what it claims to, or a
// Cache Storage edge case the in-memory fake can't model, fails step 6 while every existing gate (unit
// tests, the mocked boot smoke-test) stays green.
//
// Run: `npm run test:offline` (after `npm run build:web`). Needs Chromium:
//   npx playwright install --with-deps chromium
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyBootOutcome } from './smoke-boot.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const studioDir = join(here, '..'); // tooling/koine-studio
const distDir = join(studioDir, 'dist');

// Mirror the deploy's sub-path base, same convention as scripts/smoke-boot.mjs.
const rawBase = process.env.KOINE_STUDIO_BASE || '/Koine/studio/';
const base = `/${rawBase.replace(/^\/+|\/+$/g, '')}/`; // e.g. "/Koine/studio/"
const BOOT_TIMEOUT_MS = Number(process.env.KOINE_SMOKE_TIMEOUT_MS || 60_000);
const PRECACHE_TIMEOUT_MS = Number(process.env.KOINE_PRECACHE_TIMEOUT_MS || 30_000);

const MIME = {
  '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.html': 'text/html',
  '.json': 'application/json', '.map': 'application/json', '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.png': 'image/png',
  '.ico': 'image/x-icon', '.txt': 'text/plain', '.webmanifest': 'application/manifest+json',
  '.dat': 'application/octet-stream', '.blat': 'application/octet-stream',
};

function fail(message, extra) {
  console.error(`\n✗ studio offline smoke-test FAILED: ${message}`);
  if (extra) console.error(extra);
  process.exitCode = 1;
}

/** Static server for dist/ under `base`, with SPA fallback to index.html — same shape as smoke-boot.mjs. */
function serveDist() {
  return createServer((req, res) => {
    const p = decodeURIComponent((req.url || '/').split('?')[0]);
    if (!p.startsWith(base)) {
      res.writeHead(404).end('outside base');
      return;
    }
    let rel = p.slice(base.length);
    if (rel === '' || rel.endsWith('/')) rel += 'index.html';
    let file = normalize(join(distDir, rel));
    if (!file.startsWith(distDir) || !existsSync(file) || !statSync(file).isFile()) {
      file = join(distDir, 'index.html'); // SPA fallback
    }
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(readFileSync(file));
  });
}

/**
 * Wait until the compiler worker settles (ready+RPC, a boot/worker failure, or timeout) and classify
 * the outcome via `classifyBootOutcome` — the exact same verdict logic scripts/smoke-boot.mjs uses, so
 * "did Studio boot and compile" means one thing across both gates. `responseCounter.count` is read at
 * classification time; the caller resets it to 0 before each load so it never straddles two loads.
 */
async function waitForBootVerdict(page, timeoutMs, responseCounter) {
  const verdict = await page
    .waitForFunction(
      () => {
        const s = window.__bootSignals || [];
        const err = s.find((x) => x.ev === 'boot-failure' || x.ev === 'worker-error');
        if (err) return err.ev; // 'boot-failure' | 'worker-error'
        if (s.some((x) => x.ev === 'ready') && s.some((x) => x.ev === 'rpc' && x.ok === true)) return 'ready';
        return false;
      },
      { timeout: timeoutMs, polling: 250 },
    )
    .then((h) => h.jsonValue())
    .catch(() => 'timeout');

  const timeline = await page.evaluate(() => window.__bootSignals || []);
  const reachedReady = timeline.some((x) => x.ev === 'ready');
  const okReplies = timeline.filter((x) => x.ev === 'rpc' && x.ok === true).length;

  const outcome = classifyBootOutcome({
    verdict,
    reachedReady,
    frameworkResponses: responseCounter.count,
    okReplies,
    timeoutMs,
  });
  return { ...outcome, timeline };
}

async function main() {
  if (!existsSync(join(distDir, 'index.html'))) {
    fail(`no build at ${distDir}. Run \`npm run build:web\` first.`);
    process.exit(1);
  }

  const server = serveDist();
  await new Promise((r) => server.listen(0, r));
  const { port } = server.address();
  const url = `http://localhost:${port}${base}`;
  // Compiler worker + service worker registration both happen on the editor route (see smoke-boot.mjs).
  const bootUrl = `${url}#/editor`;

  const browser = await chromium.launch({ headless: true });
  let ok = false;
  try {
    const page = await browser.newPage();
    page.on('pageerror', (e) => console.error('[pageerror]', String(e)));

    const responseCounter = { count: 0 };
    page.on('response', (resp) => {
      if (resp.url().includes('koine-wasm/_framework/') && resp.ok()) responseCounter.count += 1;
    });

    // Tee the compiler worker exactly like scripts/smoke-boot.mjs does (kept inline, not imported — an
    // `addInitScript` callback is serialized into the page and can't close over Node-side helpers), and
    // force `requestIdleCallback` to fire on the next tick so the app's own idle-scheduled WASM precache
    // (serviceWorkerUpdate.ts's `scheduleCompilerPrecache`) isn't at the mercy of a real idle scheduler
    // under CI load. This changes WHEN the precache runs, not what it does.
    await page.addInitScript(() => {
      window.__bootT0 = performance.now();
      window.__bootSignals = [];
      const Native = window.Worker;
      window.Worker = class extends Native {
        constructor(u, o) {
          super(u, o);
          const at = () => Math.round(performance.now() - window.__bootT0);
          window.__bootSignals.push({ t: at(), ev: 'created', url: String(u).split('/').pop() });
          this.addEventListener('message', (e) => {
            const d = e.data;
            if (d && typeof d === 'object' && 'type' in d) window.__bootSignals.push({ t: at(), ev: d.type, error: d.error });
            else if (d && typeof d === 'object' && 'ok' in d) window.__bootSignals.push({ t: at(), ev: 'rpc', ok: d.ok });
          });
          this.addEventListener('error', (e) => window.__bootSignals.push({ t: at(), ev: 'worker-error', error: e.message }));
        }
      };
      window.requestIdleCallback = (cb) => setTimeout(() => cb({ didTimeout: false, timeRemaining: () => 50 }), 0);
      window.cancelIdleCallback = (id) => clearTimeout(id);
    });

    console.log(`▸ serving ${distDir}\n▸ loading ${bootUrl} (online)`);
    await page.goto(bootUrl, { waitUntil: 'load', timeout: 30_000 });

    const onlineVerdict = await waitForBootVerdict(page, BOOT_TIMEOUT_MS, responseCounter);
    if (!onlineVerdict.ok) {
      fail(`online warm-up: ${onlineVerdict.message}`, JSON.stringify(onlineVerdict.timeline, null, 2));
      return;
    }
    console.log(`✓ online warm-up: ${onlineVerdict.message}`);

    // Bounded, unlike a bare `await navigator.serviceWorker.ready`: if the SW never reaches "active"
    // (the exact regression this asserts against), that promise never settles, and this must fail fast
    // with the diagnostic below rather than hang for the rest of the job's timeout.
    const swActive = await page.evaluate(async (timeoutMs) => {
      if (!('serviceWorker' in navigator)) return false;
      const timedOut = new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs));
      const reg = await Promise.race([navigator.serviceWorker.ready, timedOut]);
      if (!reg) return false;
      return Boolean(reg.active) && Boolean(navigator.serviceWorker.controller);
    }, BOOT_TIMEOUT_MS);
    if (!swActive) {
      fail('the service worker never reached "active" / never took control of the page.');
      return;
    }
    console.log('✓ service worker active and controlling the page');

    // Wait for the (forced-immediate) idle precache to populate the WASM generation cache with the
    // loader + manifest + framework assets. This matters specifically for the loader: its own cold-start
    // fetch happens BEFORE the manifest fetch creates the generation cache (see koine-studio-sw.js's
    // handleLoaderRequest doc), so without the idle precache the loader is never cached and the offline
    // reload below would fail to import it.
    const cacheState = await page
      .waitForFunction(
        async () => {
          const names = await caches.keys();
          const wasmName = names.find((n) => n.startsWith('koine-studio-wasm-'));
          if (!wasmName) return false;
          const cache = await caches.open(wasmName);
          const keys = (await cache.keys()).map((r) => r.url);
          const hasLoader = keys.some((u) => u.endsWith('/dotnet.js'));
          const hasManifest = keys.some((u) => u.endsWith('/dotnet.boot.js'));
          return hasLoader && hasManifest && keys.length >= 5 ? { wasmName, count: keys.length } : false;
        },
        { timeout: PRECACHE_TIMEOUT_MS, polling: 500 },
      )
      .then((h) => h.jsonValue())
      .catch(() => null);
    if (!cacheState) {
      fail(
        `the WASM generation cache never held the loader + manifest + framework assets within ` +
          `${Math.round(PRECACHE_TIMEOUT_MS / 1000)}s.`,
      );
      return;
    }
    console.log(`✓ Cache Storage "${cacheState.wasmName}" holds ${cacheState.count} framework asset(s)`);

    const shellCached = await page.evaluate(async (b) => {
      const names = await caches.keys();
      const shellName = names.find((n) => n.startsWith('koine-studio-shell-'));
      if (!shellName) return false;
      const cache = await caches.open(shellName);
      return Boolean(await cache.match(`${b}index.html`));
    }, base);
    if (!shellCached) {
      fail('the app shell (index.html) was never cached.');
      return;
    }
    console.log('✓ app shell cached');

    // A SECOND online visit, before going offline (issue #1685): `precacheShell` only precaches the
    // base document + index.html at `install` — the entry JS/CSS chunks index.html references are
    // cached on demand by the fetch handler instead, which only works once the SW already CONTROLS the
    // requesting page. On the very first-ever navigation the browser's HTML parser fetches those entry
    // chunks before the page's own JS has run far enough to even register the SW, so they're never
    // intercepted on that first load — only a repeat visit (this SW already active and controlling from
    // byte one) gets them cached. This reload is that repeat visit; #1685 tracks closing the gap so a
    // single visit suffices.
    responseCounter.count = 0;
    console.log('▸ reloading once more online (repeat-visit warm-up — issue #1685)…');
    await page.reload({ waitUntil: 'load', timeout: 30_000 });
    const repeatVisitVerdict = await waitForBootVerdict(page, BOOT_TIMEOUT_MS, responseCounter);
    if (!repeatVisitVerdict.ok) {
      fail(`repeat-visit warm-up: ${repeatVisitVerdict.message}`, JSON.stringify(repeatVisitVerdict.timeline, null, 2));
      return;
    }
    console.log(`✓ repeat-visit warm-up: ${repeatVisitVerdict.message}`);

    const shellEntryChunksCached = await page.evaluate(async (b) => {
      const names = await caches.keys();
      const shellName = names.find((n) => n.startsWith('koine-studio-shell-'));
      if (!shellName) return false;
      const cache = await caches.open(shellName);
      const keys = (await cache.keys()).map((r) => r.url);
      return keys.some((u) => u.startsWith(`${new URL(u).origin}${b}assets/`));
    }, base);
    if (!shellEntryChunksCached) {
      fail('the app shell entry JS/CSS chunk(s) were never cached, even after a repeat visit.');
      return;
    }
    console.log('✓ app shell entry chunk(s) cached');

    // --- go offline and reload: everything from here must be served from the Cache Storage above ---
    responseCounter.count = 0;
    console.log('▸ going offline and reloading…');
    await page.context().setOffline(true);
    await page.reload({ waitUntil: 'load', timeout: 30_000 });

    const offlineVerdict = await waitForBootVerdict(page, BOOT_TIMEOUT_MS, responseCounter);
    if (!offlineVerdict.ok) {
      fail(`offline reload: ${offlineVerdict.message}`, JSON.stringify(offlineVerdict.timeline, null, 2));
      return;
    }
    console.log(`✓ offline reload: ${offlineVerdict.message} (${responseCounter.count} _framework responses, all from cache)`);

    ok = true;
  } finally {
    await browser.close();
    server.close();
  }

  if (!ok) process.exit(1);
  console.log('✓ studio offline smoke-test passed.');
}

await main();
