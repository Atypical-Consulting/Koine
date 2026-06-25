// End-to-end browser boot smoke-test for the WEB build of Koine Studio (issue #357).
//
// Why this exists: the vitest/storybook suite MOCKS the compiler worker, so "does the real .NET
// WebAssembly compiler actually boot in a browser?" is never asserted anywhere that gates the
// deploy. That gap let #326 ship a worker boot that hangs in production ("connection failed"): the
// worker downloads the whole runtime, but `dotnet.create()` never settles, so the host times out.
//
// This script serves the built `dist/` exactly as the deploy does — under the sub-path base
// (KOINE_STUDIO_BASE, e.g. /Koine/studio/) — launches headless Chromium, and asserts the compiler
// worker actually reaches `ready` (and is not stuck in the error state). It exits non-zero with a
// timeline diagnostic when the boot hangs, so CI fails instead of shipping a dead studio.
//
// Run: `npm run test:browser` (after `npm run build:web`). Needs Chromium:
//   npx playwright install --with-deps chromium
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const studioDir = join(here, '..'); // tooling/koine-studio
const distDir = join(studioDir, 'dist');

// Mirror the deploy's sub-path base. Trailing slash normalized to a single leading+trailing form.
const rawBase = process.env.KOINE_STUDIO_BASE || '/Koine/studio/';
const base = `/${rawBase.replace(/^\/+|\/+$/g, '')}/`; // e.g. "/Koine/studio/"
const BOOT_TIMEOUT_MS = Number(process.env.KOINE_SMOKE_TIMEOUT_MS || 60_000);

const MIME = {
  '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.html': 'text/html',
  '.json': 'application/json', '.map': 'application/json', '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.png': 'image/png',
  '.ico': 'image/x-icon', '.txt': 'text/plain', '.webmanifest': 'application/manifest+json',
  '.dat': 'application/octet-stream', '.blat': 'application/octet-stream',
};

function fail(message, extra) {
  console.error(`\n✗ studio boot smoke-test FAILED: ${message}`);
  if (extra) console.error(extra);
  process.exitCode = 1;
}

if (!existsSync(join(distDir, 'index.html'))) {
  fail(`no build at ${distDir}. Run \`npm run build:web\` first.`);
  process.exit(1);
}

// Static server for dist/ under `base`, with SPA fallback to index.html.
const server = createServer((req, res) => {
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

await new Promise((r) => server.listen(0, r));
const { port } = server.address();
const url = `http://localhost:${port}${base}`;

const browser = await chromium.launch({ headless: true });
let ok = false;
let timeline = [];
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('[pageerror]', String(e)));

  // Tee the compiler worker before any app code runs. The worker posts `{ type: 'ready' }` when the
  // runtime has booted (or `{ type: 'boot-failure', error }`), then services id-correlated RPC
  // (`{ id, ok, result }`). We assert BOTH: the boot reaches `ready` AND a real compiler call round-
  // trips — so the gate catches a silent boot hang (#357) and a broken post-boot message channel.
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
  });

  console.log(`▸ serving ${distDir}\n▸ loading ${url}`);
  await page.goto(url, { waitUntil: 'load', timeout: 30_000 });

  // Wait until the worker reaches `ready` AND an `ok` RPC reply round-trips (the app issues compiler
  // calls automatically after boot), or it fails / times out.
  const verdict = await page
    .waitForFunction(
      () => {
        const s = window.__bootSignals || [];
        if (s.some((x) => x.ev === 'boot-failure' || x.ev === 'worker-error')) return 'failed';
        if (s.some((x) => x.ev === 'ready') && s.some((x) => x.ev === 'rpc' && x.ok === true)) return 'ready';
        return false;
      },
      { timeout: BOOT_TIMEOUT_MS, polling: 250 },
    )
    .then((h) => h.jsonValue())
    .catch(() => 'timeout');

  timeline = await page.evaluate(() => window.__bootSignals || []);
  const status = await page.evaluate(() => {
    const el = document.querySelector('[data-kind]');
    return { kind: el?.getAttribute('data-kind') ?? null, text: el?.textContent?.trim() ?? null };
  });
  const reachedReady = timeline.some((x) => x.ev === 'ready');
  const okReplies = timeline.filter((x) => x.ev === 'rpc' && x.ok === true).length;

  if (verdict === 'ready') {
    console.log(`✓ compiler worker booted (ready) and RPC round-trips (${okReplies} ok replies).`);
    console.log(`  studio status: ${status.kind} "${status.text}"`);
    ok = true;
  } else if (verdict === 'failed') {
    fail('the compiler worker reported a boot failure.', JSON.stringify(timeline, null, 2));
  } else if (reachedReady) {
    fail(
      `the worker reached "ready" but no compiler call round-tripped within ${BOOT_TIMEOUT_MS / 1000}s ` +
        `(the post-boot message channel is broken). Studio status: ${status.kind} "${status.text}".`,
      JSON.stringify(timeline, null, 2),
    );
  } else {
    fail(
      `the compiler worker never reached "ready" within ${BOOT_TIMEOUT_MS / 1000}s (boot hung). ` +
        `Studio status: ${status.kind} "${status.text}".`,
      JSON.stringify(timeline, null, 2),
    );
  }
} finally {
  await browser.close();
  server.close();
}

if (!ok) process.exit(1);
console.log('✓ studio boot smoke-test passed.');
