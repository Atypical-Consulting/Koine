// End-to-end browser boot smoke-test for the deployed website Playground (issue #492).
//
// Why this exists: the website's vitest suite MOCKS the compiler worker, so "does the real .NET
// WebAssembly compiler actually boot in a browser?" is never asserted anywhere that gates the docs
// deploy. That gap let #492 ship a worker boot that hangs in production ("Koine worker timed out
// after 30s"): the worker downloads the whole runtime, but `dotnet.create()` never settles (the
// top-level `self.onmessage =` clobbers the runtime's message channel — the #357/#358 bug, un-ported
// to the website copy), so the host times out. Studio closed the identical gap with its own
// scripts/smoke-boot.mjs (#358); this is the website's equivalent.
//
// This script serves the built `dist/` exactly as the deploy does — under the sub-path base
// (KOINE_WEBSITE_BASE, e.g. /Koine/) — launches headless Chromium, and asserts the compiler worker
// actually reaches `ready` and a real RPC round-trips. It exits non-zero with a timeline diagnostic
// when the boot hangs, so CI fails instead of shipping a dead Playground.
//
// Surface: the buggy worker boots on the LANDING PAGE (src/pages/index.astro embeds <Playground/> →
// controller.ts mountPlayground), NOT at /playground/ — that route was retired (#141) and now
// redirects to Studio. So this gate loads the landing page (base root), whose embedded Playground
// boots the compiler worker on load.
//
// Diagnostics (mirrors Studio #359): a worker module that fails to LOAD/PARSE (a 404'd chunk, a
// top-level throw, a broken bundle) posts no `ready` and no `boot-failure` — only an empty-message
// `error` event. `classifyBootOutcome` distinguishes it: a worker `error` event OR zero `_framework`
// assets ever fetched ⇒ "failed to load/parse"; only a worker that fetched runtime assets but never
// settled ⇒ "boot hung". The decision is split out so it stays unit-testable without a real browser.
//
// Run: `npm run test:browser` (after `npm run build`). Needs Chromium:
//   npx playwright install --with-deps chromium
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync, realpathSync } from 'node:fs';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const websiteDir = join(here, '..'); // website/
const distDir = join(websiteDir, 'dist');

// Mirror the deploy's sub-path base (astro.config.mjs `base: '/Koine/'`). Trailing slash normalized
// to a single leading+trailing form.
const rawBase = process.env.KOINE_WEBSITE_BASE || '/Koine/';
const base = `/${rawBase.replace(/^\/+|\/+$/g, '')}/`; // e.g. "/Koine/"
const BOOT_TIMEOUT_MS = Number(process.env.KOINE_SMOKE_TIMEOUT_MS || 60_000);

const MIME = {
  '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.html': 'text/html',
  '.json': 'application/json', '.map': 'application/json', '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.png': 'image/png',
  '.ico': 'image/x-icon', '.txt': 'text/plain', '.webmanifest': 'application/manifest+json',
  '.dat': 'application/octet-stream', '.blat': 'application/octet-stream',
};

function fail(message, extra) {
  console.error(`\n✗ playground boot smoke-test FAILED: ${message}`);
  if (extra) console.error(extra);
  process.exitCode = 1;
}

/**
 * Decide the boot outcome from the observed signals. Split out from `main()` so the verdict logic is
 * unit-testable without a browser — and, crucially, so a worker that never loaded/parsed (broken
 * bundle) is reported distinctly from a runtime that fetched its assets but hung.
 *
 * @param {object} o
 * @param {'ready'|'boot-failure'|'worker-error'|'timeout'} o.verdict  the settled boot signal (or 'timeout')
 * @param {boolean} o.reachedReady   whether a `ready` signal was ever observed
 * @param {number}  o.frameworkResponses  count of successful `koine-wasm/_framework/*` responses
 * @param {number}  o.okReplies      count of `ok` RPC replies round-tripped
 * @param {number}  o.timeoutMs      the boot timeout that was waited out
 * @returns {{ ok:boolean, status:'ready'|'load-parse-failure'|'boot-failure'|'no-rpc'|'hung', message:string }}
 */
export function classifyBootOutcome({ verdict, reachedReady, frameworkResponses, okReplies, timeoutMs }) {
  const secs = Math.round(timeoutMs / 1000);

  if (verdict === 'ready') {
    return {
      ok: true,
      status: 'ready',
      message: `compiler worker booted (ready) and RPC round-trips (${okReplies} ok replies).`,
    };
  }

  // A worker `error` event, or zero `_framework` assets ever fetched, means the worker module itself
  // failed to load/parse (a 404'd chunk, a top-level throw, a broken bundle) — NOT a runtime hang.
  if (verdict === 'worker-error' || frameworkResponses === 0) {
    const why =
      verdict === 'worker-error'
        ? 'the worker raised an error event'
        : 'no koine-wasm/_framework/* asset was ever fetched';
    return {
      ok: false,
      status: 'load-parse-failure',
      message:
        `the compiler worker failed to load/parse (${why}). The bundle is broken — check the worker ` +
        `chunk / dotnet.js. This is NOT a runtime hang.`,
    };
  }

  // An explicit `boot-failure` signal: the worker imported dotnet.js and started the runtime, but it
  // failed/hung and the worker reported it (so its assets WERE fetched).
  if (verdict === 'boot-failure') {
    return { ok: false, status: 'boot-failure', message: 'the compiler worker reported a boot failure.' };
  }

  // From here the boot timed out with assets fetched but no settling signal.
  if (reachedReady) {
    return {
      ok: false,
      status: 'no-rpc',
      message:
        `the worker reached "ready" but no compiler call round-tripped within ${secs}s ` +
        `(the post-boot message channel is broken).`,
    };
  }

  return {
    ok: false,
    status: 'hung',
    message:
      `the compiler worker fetched runtime assets but never reached "ready" within ${secs}s (boot hung). ` +
      `This is the #492 / #357 channel-clobber symptom — check koine.worker.ts installs its message ` +
      `loop via addEventListener AFTER dotnet.create() resolves, never a top-level self.onmessage =.`,
  };
}

async function main() {
  if (!existsSync(join(distDir, 'index.html'))) {
    fail(`no build at ${distDir}. Run \`npm run build\` first.`);
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
  // The compiler worker boots on the LANDING PAGE — index.astro embeds <Playground/>, whose
  // controller mounts and boots the worker on load. So the gate loads the base root (the landing
  // page), not /playground/ (a redirect to Studio since #141).
  const bootUrl = url;

  const browser = await chromium.launch({ headless: true });
  let ok = false;
  let timeline = [];
  try {
    const page = await browser.newPage();
    page.on('pageerror', (e) => console.error('[pageerror]', String(e)));

    // Count successful `_framework` asset responses (the worker's `import(dotnet.js)` and the runtime's
    // own fetches both surface here). Zero ⇒ the worker never loaded its runtime — a load/parse failure
    // rather than a hang. 404s are excluded (`resp.ok()`) so a missing dotnet.js doesn't masquerade as
    // "assets fetched".
    let frameworkResponses = 0;
    page.on('response', (resp) => {
      if (resp.url().includes('koine-wasm/_framework/') && resp.ok()) frameworkResponses += 1;
    });

    // Tee the compiler worker before any app code runs. The worker posts `{ type: 'ready' }` when the
    // runtime has booted (or `{ type: 'boot-failure', error }`), then services id-correlated RPC
    // (`{ id, ok, result }`). We assert BOTH: the boot reaches `ready` AND a real compiler call round-
    // trips — so the gate catches a silent boot hang (#492) and a broken post-boot message channel.
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

    console.log(`▸ serving ${distDir}\n▸ loading ${bootUrl}`);
    await page.goto(bootUrl, { waitUntil: 'load', timeout: 30_000 });

    // Wait until the worker reaches `ready` AND an `ok` RPC reply round-trips (the playground issues a
    // compile call automatically after boot), or it fails / times out. A `worker-error` is reported
    // distinctly from a `boot-failure` so the verdict can tell a load/parse failure from a runtime one.
    const verdict = await page
      .waitForFunction(
        () => {
          const s = window.__bootSignals || [];
          const err = s.find((x) => x.ev === 'boot-failure' || x.ev === 'worker-error');
          if (err) return err.ev; // 'boot-failure' | 'worker-error'
          if (s.some((x) => x.ev === 'ready') && s.some((x) => x.ev === 'rpc' && x.ok === true)) return 'ready';
          return false;
        },
        { timeout: BOOT_TIMEOUT_MS, polling: 250 },
      )
      .then((h) => h.jsonValue())
      .catch(() => 'timeout');

    timeline = await page.evaluate(() => window.__bootSignals || []);
    const status = await page.evaluate(() => {
      const el = document.querySelector('.koi-status');
      return { kind: el?.getAttribute('data-kind') ?? null, text: el?.textContent?.trim() ?? null };
    });
    const reachedReady = timeline.some((x) => x.ev === 'ready');
    const okReplies = timeline.filter((x) => x.ev === 'rpc' && x.ok === true).length;

    const outcome = classifyBootOutcome({
      verdict,
      reachedReady,
      frameworkResponses,
      okReplies,
      timeoutMs: BOOT_TIMEOUT_MS,
    });

    if (outcome.ok) {
      console.log(`✓ ${outcome.message}`);
      console.log(`  playground status: ${status.kind} "${status.text}"`);
      ok = true;
    } else {
      fail(
        `${outcome.message} Playground status: ${status.kind} "${status.text}" ` +
          `(${frameworkResponses} _framework responses).`,
        JSON.stringify(timeline, null, 2),
      );
    }
  } finally {
    await browser.close();
    server.close();
  }

  if (!ok) process.exit(1);
  console.log('✓ playground boot smoke-test passed.');
}

// Run the browser smoke-test only when executed directly (`node scripts/smoke-boot.mjs`). When this
// module is imported (e.g. to unit-test `classifyBootOutcome`), the server / browser launch is
// skipped so importing it has no side effects.
const runDirectly = (() => {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (runDirectly) await main();
