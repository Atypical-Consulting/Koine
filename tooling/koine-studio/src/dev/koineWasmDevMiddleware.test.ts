import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKoineWasmDevMiddleware } from './koineWasmDevMiddleware';

function mockRes() {
  return {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: undefined as Buffer | undefined,
    setHeader(k: string, v: string) {
      this.headers[k.toLowerCase()] = v;
    },
    writeHead(code: number) {
      this.statusCode = code;
      return this;
    },
    end(b?: Buffer) {
      this.body = b as Buffer;
    },
  };
}

describe('createKoineWasmDevMiddleware', () => {
  let publicDir: string;
  beforeEach(() => {
    publicDir = mkdtempSync(join(tmpdir(), 'koine-public-'));
    mkdirSync(join(publicDir, 'koine-wasm/_framework'), { recursive: true });
    writeFileSync(join(publicDir, 'koine-wasm/_framework/dotnet.js'), 'export const dotnet = {};');
  });
  afterEach(() => rmSync(publicDir, { recursive: true, force: true }));

  it('serves a query-suffixed /koine-wasm/*.js request as raw JS (200), not next()', () => {
    const mw = createKoineWasmDevMiddleware(publicDir);
    const res = mockRes();
    let nexted = false;
    mw(
      { method: 'GET', url: '/koine-wasm/_framework/dotnet.js?import' } as never,
      res as never,
      () => {
        nexted = true;
      },
    );
    expect(nexted).toBe(false);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/javascript/);
    expect(res.body?.toString()).toContain('export const dotnet');
  });

  it('passes through a no-query request untouched (Vite public middleware handles it)', () => {
    const mw = createKoineWasmDevMiddleware(publicDir);
    const res = mockRes();
    let nexted = false;
    mw({ method: 'GET', url: '/koine-wasm/_framework/dotnet.js' } as never, res as never, () => {
      nexted = true;
    });
    expect(nexted).toBe(true);
    expect(res.statusCode).toBe(0);
  });

  it('passes through non-koine-wasm requests untouched', () => {
    const mw = createKoineWasmDevMiddleware(publicDir);
    const res = mockRes();
    let nexted = false;
    mw({ method: 'GET', url: '/src/main.ts' } as never, res as never, () => {
      nexted = true;
    });
    expect(nexted).toBe(true);
  });

  it('does not serve outside publicDir (path traversal → next())', () => {
    const mw = createKoineWasmDevMiddleware(publicDir);
    const res = mockRes();
    let nexted = false;
    mw(
      { method: 'GET', url: '/koine-wasm/../../../etc/passwd?import' } as never,
      res as never,
      () => {
        nexted = true;
      },
    );
    expect(nexted).toBe(true);
    expect(res.statusCode).toBe(0);
  });

  it('passes through a non-GET/HEAD method untouched', () => {
    const mw = createKoineWasmDevMiddleware(publicDir);
    const res = mockRes();
    let nexted = false;
    mw(
      { method: 'POST', url: '/koine-wasm/_framework/dotnet.js?import' } as never,
      res as never,
      () => {
        nexted = true;
      },
    );
    expect(nexted).toBe(true);
    expect(res.statusCode).toBe(0);
  });
});
