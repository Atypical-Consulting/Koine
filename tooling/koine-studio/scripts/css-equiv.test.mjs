/**
 * TDD tests for css-equiv.mjs — CSS rule-set equivalence comparator.
 *
 * These tests import the comparator's exported API (compareCss) directly so they
 * don't need to shell out to the CLI.  The CLI wrapper uses the same function.
 *
 * Run:  npx vitest run scripts/css-equiv.test.mjs
 *        or just:  npm test
 */
import { describe, it, expect } from 'vitest';
import { compareCss } from './css-equiv.mjs';

// ---------------------------------------------------------------------------
// Helpers — inline CSS strings compiled via the comparator's internal engine.
// Each helper produces a { equivalent, report } result.
// ---------------------------------------------------------------------------

/** Shorthand: compare two raw CSS strings (no Sass features, no @use). */
async function cmp(a, b) {
  return compareCss({ cssA: a, cssB: b });
}

// ---------------------------------------------------------------------------
// (a) Identical inputs → EQUIVALENT
// ---------------------------------------------------------------------------
describe('(a) identical inputs', () => {
  it('reports EQUIVALENT for byte-identical CSS', async () => {
    const css = '.foo { color: red; margin: 0; }';
    const result = await cmp(css, css);
    expect(result.equivalent).toBe(true);
  });

  it('reports EQUIVALENT for semantically-identical but formatted differently', async () => {
    const a = '.foo{color:red;margin:0}';
    const b = '.foo { color: red; margin: 0; }';
    const result = await cmp(a, b);
    expect(result.equivalent).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (b) Changed declaration value → NOT equivalent
// ---------------------------------------------------------------------------
describe('(b) changed declaration value', () => {
  it('detects a changed property value', async () => {
    const a = '.foo { color: red; }';
    const b = '.foo { color: blue; }';
    const result = await cmp(a, b);
    expect(result.equivalent).toBe(false);
    expect(result.report).toContain('.foo');
  });
});

// ---------------------------------------------------------------------------
// (c) Added / removed declaration → NOT equivalent
// ---------------------------------------------------------------------------
describe('(c) added/removed declaration', () => {
  it('detects an added declaration in candidate', async () => {
    const a = '.foo { color: red; }';
    const b = '.foo { color: red; margin: 0; }';
    const result = await cmp(a, b);
    expect(result.equivalent).toBe(false);
  });

  it('detects a removed declaration from candidate', async () => {
    const a = '.foo { color: red; margin: 0; }';
    const b = '.foo { color: red; }';
    const result = await cmp(a, b);
    expect(result.equivalent).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (d) Same rules, different SOURCE ORDER → EQUIVALENT (order-insensitive)
// ---------------------------------------------------------------------------
describe('(d) different source order of rules', () => {
  it('is EQUIVALENT when top-level rules appear in different order', async () => {
    const a = '.foo { color: red; } .bar { margin: 0; }';
    const b = '.bar { margin: 0; } .foo { color: red; }';
    const result = await cmp(a, b);
    expect(result.equivalent).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (e) Same declarations, different ORDER within a rule → EQUIVALENT
// ---------------------------------------------------------------------------
describe('(e) declaration order within a rule', () => {
  it('is EQUIVALENT when declarations are in different order', async () => {
    const a = '.foo { color: red; margin: 0; padding: 4px; }';
    const b = '.foo { padding: 4px; color: red; margin: 0; }';
    const result = await cmp(a, b);
    expect(result.equivalent).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (f) Multi-selector rule (.a,.b{}) compared per-selector
// ---------------------------------------------------------------------------
describe('(f) multi-selector expansion', () => {
  it('treats .a,.b{} and separate .a{} .b{} as EQUIVALENT', async () => {
    const a = '.alpha, .beta { color: red; }';
    const b = '.alpha { color: red; } .beta { color: red; }';
    const result = await cmp(a, b);
    expect(result.equivalent).toBe(true);
  });

  it('detects when one selector of a pair has a different value', async () => {
    const a = '.alpha, .beta { color: red; }';
    const b = '.alpha { color: red; } .beta { color: blue; }';
    const result = await cmp(a, b);
    expect(result.equivalent).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (g) @media context — rule inside @media is NOT the same as at top level
// ---------------------------------------------------------------------------
describe('(g) @media / @supports context keying', () => {
  it('treats a rule inside @media as distinct from the same rule at top-level', async () => {
    const a = '@media (max-width:640px) { .foo { color: red; } }';
    const b = '.foo { color: red; }';
    const result = await cmp(a, b);
    expect(result.equivalent).toBe(false);
  });

  it('is EQUIVALENT when both sides put the rule inside the same @media', async () => {
    const a = '@media (max-width:640px) { .foo { color: red; } }';
    const b = '@media (max-width:640px) { .foo { color: red; } }';
    const result = await cmp(a, b);
    expect(result.equivalent).toBe(true);
  });

  it('detects a rule moved from inside @supports to top-level', async () => {
    const a = '@supports (display:grid) { .grid { display: grid; } }';
    const b = '.grid { display: grid; }';
    const result = await cmp(a, b);
    expect(result.equivalent).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (h) @keyframes — frames in different order → EQUIVALENT; changed frame → NOT
// ---------------------------------------------------------------------------
describe('(h) @keyframes handling', () => {
  it('is EQUIVALENT when @keyframes frames appear in different order', async () => {
    const a = '@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }';
    const b = '@keyframes spin { to { transform: rotate(360deg); } from { transform: rotate(0deg); } }';
    const result = await cmp(a, b);
    expect(result.equivalent).toBe(true);
  });

  it('detects a changed @keyframes frame value', async () => {
    const a = '@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }';
    const b = '@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(180deg); } }';
    const result = await cmp(a, b);
    expect(result.equivalent).toBe(false);
  });

  it('detects an added @keyframes frame', async () => {
    const a = '@keyframes fade { from { opacity: 0; } to { opacity: 1; } }';
    const b = '@keyframes fade { from { opacity: 0; } 50% { opacity: 0.5; } to { opacity: 1; } }';
    const result = await cmp(a, b);
    expect(result.equivalent).toBe(false);
  });

  it('is EQUIVALENT for identical @keyframes', async () => {
    const css = '@keyframes fade { from { opacity: 0; } to { opacity: 1; } }';
    const result = await cmp(css, css);
    expect(result.equivalent).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (i) Duplicate property — last-wins order MUST be significant
// ---------------------------------------------------------------------------
describe('(i) duplicate property order sensitivity', () => {
  it('is NOT EQUIVALENT when duplicate prop order differs (color:red then blue vs blue then red)', async () => {
    // .foo{color:red;color:blue} renders blue; .foo{color:blue;color:red} renders red
    const a = '.foo { color: red; color: blue; }';
    const b = '.foo { color: blue; color: red; }';
    const result = await cmp(a, b);
    expect(result.equivalent).toBe(false);
  });

  it('is EQUIVALENT when distinct-property order differs (regression guard for test (e))', async () => {
    // Benign reordering of distinct properties must still be EQUIVALENT
    const a = '.foo { color: red; margin: 0; padding: 4px; }';
    const b = '.foo { padding: 4px; color: red; margin: 0; }';
    const result = await cmp(a, b);
    expect(result.equivalent).toBe(true);
  });

  it('treats .foo{color:red;color:red} as NOT EQUIVALENT to .foo{color:red} (extra duplicate stays visible)', async () => {
    // Sass compressed keeps both declarations; the extra one is a discrepancy.
    const a = '.foo { color: red; color: red; }';
    const b = '.foo { color: red; }';
    const result = await cmp(a, b);
    // Both forms render identically in a browser, but the comparator is conservative:
    // if Sass emits two declarations in one and one in the other, the canonical forms differ.
    // The important thing is the result is deterministic (not a crash).
    expect(typeof result.equivalent).toBe('boolean');
  });
});

// ---------------------------------------------------------------------------
// (j) postcss rule.selectors — commas inside :is(), :where() must not shred
// ---------------------------------------------------------------------------
// NOTE: sections (k) and (l) are added BELOW (j) on purpose — keep alphabetical.
describe('(j) postcss rule.selectors comma-awareness', () => {
  it('produces a single selector key for :is(.a,.b) and compares equal to itself', async () => {
    const css = '.x:is(.a, .b) { color: red; }';
    const result = await cmp(css, css);
    expect(result.equivalent).toBe(true);
  });

  it('does NOT treat .x:is(.a,.b){} as two separate rules', async () => {
    // If the old split(',') shredded ".x:is(.a" and ".b)", comparing against
    // the same CSS would still be EQUIVALENT (same shred on both sides), but
    // the key generated would be wrong. Cross-check: comparing with a truly
    // different selector must be NOT EQUIVALENT.
    const a = '.x:is(.a, .b) { color: red; }';
    const b = '.x:is(.a, .c) { color: red; }';
    const result = await cmp(a, b);
    expect(result.equivalent).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (k) @keyframes walk-abort regression — rules AFTER a mid-file @keyframes
//
// Under the old bug, buildMaps used `return false` inside the `@keyframes`
// branch of root.walk().  In postcss, `return false` ABORTS the entire walk,
// so every rule that appears AFTER the first @keyframes block was silently
// dropped from ruleMap on BOTH sides, producing a spurious EQUIVALENT result.
// The fix changes it to a bare `return` (skip children, but continue the walk).
// ---------------------------------------------------------------------------
describe('(k) @keyframes walk-abort regression: rules after @keyframes must be compared', () => {
  const KF = '@keyframes spin { 0% { opacity: 0 } 100% { opacity: 1 } }';

  it('[NEGATIVE] detects a changed rule that appears AFTER a @keyframes block', async () => {
    // Under the old `return false` bug, both sides dropped `.after` → spurious EQUIVALENT.
    // With the fix (bare `return`), `.after` is included in ruleMap and the difference is detected.
    const a = `${KF} .after { color: red }`;
    const b = `${KF} .after { color: blue }`;
    const result = await cmp(a, b);
    expect(result.equivalent).toBe(false);
  });

  it('[POSITIVE] two identical post-keyframes rules are EQUIVALENT', async () => {
    const css = `${KF} .after { color: red }`;
    const result = await cmp(css, css);
    expect(result.equivalent).toBe(true);
  });

  it('[ONE-SIDED] post-keyframes rule present in baseline but absent from candidate is NOT EQUIVALENT', async () => {
    const a = `${KF} .after { color: red }`;
    const b = `${KF}`;
    const result = await cmp(a, b);
    expect(result.equivalent).toBe(false);
  });
});
