import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type ViteDevServer } from 'vite';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { koineWasmDevPlugin } from './koineWasmDevMiddleware';

// These boot a REAL Vite dev server, so they prove middleware ordering — the part a pure unit test of
// the handler can't reach. The temp root mirrors the studio: a public/ dir holding the published wasm
// loader, which makes Vite's `checkPublicFile` fire on a `?import` request (issue #384).

let server: ViteDevServer | undefined;
let root: string | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function makeRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'koine-root-'));
  mkdirSync(join(dir, 'public/koine-wasm/_framework'), { recursive: true });
  writeFileSync(join(dir, 'public/koine-wasm/_framework/dotnet.js'), 'export const dotnet = {};');
  writeFileSync(join(dir, 'index.html'), '<!doctype html><html><body></body></html>');
  return dir;
}

async function start(plugins: ReturnType<typeof koineWasmDevPlugin>[]): Promise<number> {
  server = await createServer({
    root,
    configFile: false,
    logLevel: 'silent',
    server: { port: 0 },
    plugins,
  });
  await server.listen();
  const addr = server.httpServer!.address();
  return typeof addr === 'object' && addr ? addr.port : 0;
}

const IMPORT_URL = '/koine-wasm/_framework/dotnet.js?import';

describe('koineWasmDevPlugin (dev-server integration)', () => {
  it('CONTROL: without the plugin, Vite rejects the ?import public asset with 500', async () => {
    root = makeRoot();
    const port = await start([]);
    const resp = await fetch(`http://localhost:${port}${IMPORT_URL}`);
    // ERR_LOAD_PUBLIC_URL — "This file is in /public … should not be imported from source code." Vite
    // serves this as a 500 today; assert "rejected" (>= 400) rather than pinning the exact status so the
    // control survives a future Vite that picks a different error code, while still proving the bug.
    expect(resp.status).toBeGreaterThanOrEqual(400);
  });

  it('serves /koine-wasm/_framework/dotnet.js?import as 200 with the plugin (no ERR_LOAD_PUBLIC_URL)', async () => {
    root = makeRoot();
    const port = await start([koineWasmDevPlugin()]);
    const resp = await fetch(`http://localhost:${port}${IMPORT_URL}`);
    expect(resp.status).toBe(200);
    expect(resp.headers.get('content-type')).toMatch(/javascript/);
    expect(await resp.text()).toContain('export const dotnet');
  });
});
