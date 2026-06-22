#!/usr/bin/env node
// One-shot migration: rewrite every RELATIVE module specifier under src/ to the '@/<path>' alias.
// Anchored to real module positions (import/export-from, dynamic import(), side-effect import '...',
// and vitest vi.mock/doMock/importActual/importMock) so plain data strings like '../escape.koi' or
// '../evil.cs' are never touched. Run once from tooling/koine-studio/, then delete.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, dirname, posix, sep } from 'node:path';

const SRC = join(process.cwd(), 'src');

function walk(dir, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (/\.tsx?$/.test(e.name)) acc.push(p);
  }
  return acc;
}

// group 1 = prefix incl. opening quote; group 2 = relative specifier; group 3 = closing quote
const PATTERNS = [
  /(\bfrom\s*['"])(\.[^'"]*)(['"])/g,                                              // import/export ... from '...'
  /(\bimport\s*\(\s*['"])(\.[^'"]*)(['"])/g,                                       // import('...') (dynamic + type)
  /(\bimport\s*['"])(\.[^'"]*)(['"])/g,                                            // side-effect import '...'
  /(\bvi\.(?:mock|doMock|importActual|importMock)\s*\(\s*['"])(\.[^'"]*)(['"])/g,  // vitest mocks
];

let files = 0, edits = 0;
for (const file of walk(SRC)) {
  const rel = relative(SRC, dirname(file)).split(sep).join('/');
  const base = rel === '' || rel === '.' ? '' : rel;                              // '' for src/*, 'panels', 'host/browser'
  let text = readFileSync(file, 'utf8');
  let changed = false;
  for (const re of PATTERNS) {
    text = text.replace(re, (_m, pre, spec, post) => {
      const resolved = posix.normalize(posix.join(base, spec));                   // './editor'->'editor', '../store/index'->'store/index'
      changed = true; edits++;
      return `${pre}@/${resolved}${post}`;
    });
  }
  if (changed) { writeFileSync(file, text); files++; }
}
console.log(`rewrote ${edits} specifiers across ${files} files`);
