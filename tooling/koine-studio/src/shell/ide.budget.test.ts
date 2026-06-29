// Structural guard for the ide.tsx composition root (#757). `src/shell/ide.tsx` is the app
// composition root; left unguarded it has twice regrown into a god-file — issue #180 carved the old
// 2,615-LOC `ide.ts` into tested modules but added no guard, so it silently regrew to ~2,451 LOC, which
// is why #757 re-decomposes it AND ratchets this budget so it cannot happen a third time.
//
// This reads the REAL ide.tsx from disk (not a fixture) and asserts its total line count stays under a
// ceiling that is lowered on every extraction in #757. The count is whitespace-tolerant — total lines,
// matching `wc -l` — so reformatting never flips the guard; only real growth does. When the next Studio
// feature pushes ide.tsx back over budget, this fails CI (`.github/workflows/koine-studio.yml` → `npm
// test`), pointing the contributor at a controller to extend instead of `init()` to grow.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// RATCHET: lower this on every ide.tsx extraction; target ≤ ~800.
const IDE_TSX_MAX_LINES = 1861;

describe('ide.tsx line-budget guard', () => {
  it(`keeps ide.tsx under ${IDE_TSX_MAX_LINES} lines (the composition root must stay thin)`, () => {
    const source = readFileSync(resolve(process.cwd(), 'src/shell/ide.tsx'), 'utf8');
    // Count total lines like `wc -l` (newline-terminated): the number of newline characters. Robust to
    // a missing trailing newline (split-then-trim) and indifferent to blank/whitespace lines.
    const lines = source.split('\n');
    const lineCount = lines.length > 0 && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
    expect(lineCount).toBeLessThanOrEqual(IDE_TSX_MAX_LINES);
  });
});
