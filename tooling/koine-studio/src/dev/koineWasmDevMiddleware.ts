// Dev-server only: serve query-suffixed `/koine-wasm/**` requests (the `?import` dynamic imports the
// browser WASM host issues for dotnet.js) as RAW static assets, so they bypass Vite's transform
// middleware — which otherwise rejects a /public asset with ERR_LOAD_PUBLIC_URL (500) and pops the HMR
// error overlay (issue #384). No-query requests are left to Vite's own public-asset serving.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, normalize, extname, sep } from 'node:path';
import type { Connect, Plugin } from 'vite';

const MIME: Record<string, string> = {
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
};
const SEGMENT = '/koine-wasm/';

/**
 * A connect-style middleware that serves query-suffixed `/koine-wasm/**` requests straight from
 * `publicDir`. It handles a request only when ALL hold: the method is GET/HEAD; the path carries a
 * query string (the `?import` case Vite would otherwise route through its transform pipeline and
 * reject); the path contains the `/koine-wasm/` segment; and the resolved file exists inside
 * `publicDir` (path-traversal-guarded). Anything else calls `next()` untouched — so no-query asset
 * requests keep flowing to Vite's existing public-asset serving exactly as before.
 */
export function createKoineWasmDevMiddleware(publicDir: string): Connect.NextHandleFunction {
  const root = normalize(publicDir);
  return (req, res, next) => {
    const method = req.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') return next();
    const url = req.url ?? '';
    const qIdx = url.indexOf('?');
    if (qIdx < 0) return next(); // only the ?import (query) case Vite rejects
    const pathOnly = url.slice(0, qIdx);
    const seg = pathOnly.indexOf(SEGMENT);
    if (seg < 0) return next(); // not a koine-wasm asset
    const rel = pathOnly.slice(seg + 1); // "koine-wasm/_framework/dotnet.js"
    let decoded: string;
    try {
      decoded = decodeURIComponent(rel);
    } catch {
      // Malformed percent-encoding (e.g. `…/foo%zz.js`). decodeURIComponent throws URIError — DON'T let
      // it propagate: an uncaught throw here lands in Vite's error middleware as a 500 + overlay, the
      // exact failure this plugin exists to prevent (issue #384). Pass it through instead.
      return next();
    }
    const file = normalize(join(root, decoded));
    // Path-traversal guard: the resolved file must live strictly under publicDir. `root + sep` (not a
    // bare `startsWith(root)`) avoids a sibling-prefix false positive (e.g. `/pub-2` vs `/pub`).
    if (!file.startsWith(root + sep) || !existsSync(file) || !statSync(file).isFile()) return next();
    res.statusCode = 200;
    res.setHeader('Content-Type', MIME[extname(file)] ?? 'application/octet-stream');
    res.end(method === 'HEAD' ? undefined : readFileSync(file));
  };
}

/**
 * Dev-only Vite plugin: serve query-suffixed `/koine-wasm/**` imports as raw assets (see the
 * middleware above). Registered as a PRE-middleware (added directly in `configureServer`, not via a
 * returned post-hook) so it runs BEFORE Vite's internal transform/public middlewares. `apply: 'serve'`
 * keeps it inert in `vite build`, so the production bundle is provably untouched (issue #384).
 */
export function koineWasmDevPlugin(): Plugin {
  return {
    name: 'koine-wasm-dev-asset',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(createKoineWasmDevMiddleware(server.config.publicDir));
    },
  };
}
