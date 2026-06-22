#!/usr/bin/env node
// Rewrite exact '@/<old>' module specifiers to '@/<new>' across src/. Matches only a COMPLETE quoted
// literal ('<old>' or "<old>"), so '@/store' is remapped but '@/store/index' / '@/store/hooks' are not.
// Usage: node scripts/move-specifiers.mjs '{"@/selection":"@/model/selection", ...}'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const map = JSON.parse(process.argv[2] ?? '{}');
const SRC = join(process.cwd(), 'src');
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function walk(dir, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (/\.tsx?$/.test(e.name)) acc.push(p);
  }
  return acc;
}

let edits = 0;
for (const file of walk(SRC)) {
  let text = readFileSync(file, 'utf8');
  let changed = false;
  for (const [oldSpec, newSpec] of Object.entries(map)) {
    const re = new RegExp(`(['"])${esc(oldSpec)}\\1`, 'g');   // '<old>' or "<old>" exactly
    text = text.replace(re, (_m, q) => { changed = true; edits++; return `${q}${newSpec}${q}`; });
  }
  if (changed) writeFileSync(file, text);
}
console.log(`rewrote ${edits} specifiers`);
