import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dirname, '..'); // tooling/koine-studio/src
const HOST_DIR = join(SRC, 'host'); // the adapters — the only place platform identity may be used

// Platform-identity branching the UI must never use, caught in any form a future edit might
// introduce: an `isTauri()` call, an (in)equality against a platform kind in either quote style
// (`=== 'tauri'`, `!== "browser"`, …), or a `switch` arm on one (`case 'tauri'` / `case "browser"`).
// Other `.kind` fields (model / FsEntry) compare to 'file'/'dir'/'context'/… so there are no false
// positives. See README "Host abstraction (the Platform port)".
const BANNED = /\bisTauri\s*\(|(===|!==)\s*['"](tauri|browser)['"]|\bcase\s+['"](tauri|browser)['"]/;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return p === HOST_DIR ? [] : walk(p); // src/host is the adapter home
    return /\.(ts|tsx)$/.test(name) && !/\.test\./.test(name) ? [p] : [];
  });
}

describe('host seam guard', () => {
  it('no platform-identity branching outside src/host/', () => {
    const offenders = walk(SRC).filter((f) => BANNED.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
