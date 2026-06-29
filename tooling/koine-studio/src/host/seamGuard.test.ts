import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dirname, '..'); // tooling/koine-studio/src
const BANNED = /\bisTauri\s*\(|(===|!==)\s*'(tauri|browser)'/;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return p.endsWith('/host') || name === 'host' ? [] : walk(p);
    return /\.(ts|tsx)$/.test(name) && !/\.test\./.test(name) ? [p] : [];
  });
}

describe('host seam guard', () => {
  it('no platform-identity branching outside src/host/', () => {
    const offenders = walk(SRC)
      .filter((f) => !f.includes(`${join('src', 'host')}`))
      .filter((f) => BANNED.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
