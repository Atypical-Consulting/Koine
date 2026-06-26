import { describe, expect, test } from 'vitest';
import { Text } from '@codemirror/state';
import { buildSemanticDecorations, decodeSemanticTokens, SEMANTIC_TOKEN_TYPES } from './semanticTokens';

// The pure decode for LSP semantic tokens (issue #367, the docs-site playground consumer): the 5-int
// delta stream `[deltaLine, deltaStartChar, length, tokenType, tokenModifiers]` → absolute,
// offset-resolved tokens with a CSS class. Mirrors Koine Studio's proven decode (#361) 1:1 — the two
// live in separate Vite build roots, so the playground keeps a contract-pinned copy (the same reason
// koine.worker.ts is a sanctioned copy). Runs on a CodeMirror `Text` (no EditorView/DOM), so the delta
// arithmetic (same-line vs new-line column reset), the legend index → class map, the declaration
// modifier bit, and the defensive drops (bad index, zero length, out-of-doc) are all pinned here.

// The legend MUST stay in lock-step with SemanticTokenProvider.TokenTypeNames in C# (do not reorder):
// 0=type 1=enum 2=enumMember 3=property 4=keyword 5=parameter.
const DECLARATION = 1 << 0;

// Three lines so the new-line column reset (deltaLine != 0 ⇒ deltaStartChar is absolute) is exercised.
//   line 0 [0,11]  "value Money" — 'value' 0..5, 'Money' 6..11
//   line 1 [12,20] "  amount Int"
//   line 2 [21,..] "enum Status"
const doc = Text.of(['value Money', '  amount Int', 'enum Status']);

describe('decodeSemanticTokens', () => {
  test('the legend is the fixed 6-name order tied to SemanticTokenProvider.TokenTypeNames', () => {
    expect([...SEMANTIC_TOKEN_TYPES]).toEqual([
      'type',
      'enum',
      'enumMember',
      'property',
      'keyword',
      'parameter',
    ]);
  });

  test('decodes a single token at (0,0) — first deltas are absolute from the document start', () => {
    // 'Money' is not at (0,0); use a token covering 'value' (offsets 0..5) typed as a keyword (index 4).
    const tokens = decodeSemanticTokens([0, 0, 5, 4, 0], doc);
    expect(tokens).toEqual([{ from: 0, to: 5, cls: 'cm-st-keyword' }]);
  });

  test('a same-line token: deltaStartChar is relative to the previous token start', () => {
    // 'value' (kw) at col 0 len 5, then 'Money' (type, index 0) on the SAME line: deltaStartChar 6 is
    // relative to the previous token's column (0) ⇒ absolute col 6, offset 6..11.
    const tokens = decodeSemanticTokens(
      [0, 0, 5, 4, 0, /* same line */ 0, 6, 5, 0, 0],
      doc,
    );
    expect(tokens).toEqual([
      { from: 0, to: 5, cls: 'cm-st-keyword' },
      { from: 6, to: 11, cls: 'cm-st-type' },
    ]);
  });

  test('a new-line token resets the column: deltaStartChar becomes absolute again', () => {
    // 'Money' (type) on line 0 col 6, then 'amount' (property, index 3) on line 1 col 2 (offset 14):
    // deltaLine 1 ⇒ deltaStartChar 2 is absolute (not added to the previous col 6).
    const tokens = decodeSemanticTokens(
      [0, 6, 5, 0, 0, /* next line */ 1, 2, 6, 3, 0],
      doc,
    );
    expect(tokens).toEqual([
      { from: 6, to: 11, cls: 'cm-st-type' }, // 'Money'
      { from: 14, to: 20, cls: 'cm-st-property' }, // line 1 starts at offset 12, +2 = 14, 'amount' len 6
    ]);
  });

  test('the declaration modifier bit appends the cm-st-declaration class', () => {
    const [decl] = decodeSemanticTokens([0, 6, 5, 0, DECLARATION], doc);
    expect(decl.cls).toBe('cm-st-type cm-st-declaration');
  });

  test('maps each legend index to its cm-st-<type> class', () => {
    // One token per type index, each on its own (absolute) line so the math is trivial. Line 0..5 don't
    // all exist in `doc`, so use a tall blank doc for this pure index→class check.
    const tall = Text.of(['x', 'x', 'x', 'x', 'x', 'x']);
    const data = [
      0, 0, 1, 0, 0, // type
      1, 0, 1, 1, 0, // enum
      1, 0, 1, 2, 0, // enumMember
      1, 0, 1, 3, 0, // property
      1, 0, 1, 4, 0, // keyword
      1, 0, 1, 5, 0, // parameter
    ];
    expect(decodeSemanticTokens(data, tall).map((t) => t.cls)).toEqual([
      'cm-st-type',
      'cm-st-enum',
      'cm-st-enumMember',
      'cm-st-property',
      'cm-st-keyword',
      'cm-st-parameter',
    ]);
  });

  test('returns [] for an empty stream (graceful degradation to the static grammar)', () => {
    expect(decodeSemanticTokens([], doc)).toEqual([]);
  });

  test('drops a token with an unknown type index', () => {
    expect(decodeSemanticTokens([0, 0, 5, 99, 0], doc)).toEqual([]);
  });

  test('drops a token with zero or negative length', () => {
    expect(decodeSemanticTokens([0, 0, 0, 0, 0], doc)).toEqual([]);
    expect(decodeSemanticTokens([0, 0, -3, 0, 0], doc)).toEqual([]);
  });

  test('drops a token whose line is past the end of the document', () => {
    // deltaLine 99 lands well past the 3-line doc — dropped defensively, never throws.
    expect(decodeSemanticTokens([99, 0, 5, 0, 0], doc)).toEqual([]);
  });

  test('clamps a token that runs past the line end to the line end', () => {
    // 'value' line is offsets 0..11; ask for a length-99 token at col 0 → clamped to the line end (11).
    const [tok] = decodeSemanticTokens([0, 0, 99, 0, 0], doc);
    expect(tok).toEqual({ from: 0, to: 11, cls: 'cm-st-type' });
  });

  test('ignores a trailing partial group (not a multiple of 5)', () => {
    // One full token + 3 leftover ints — the partial tail is ignored, not decoded.
    const tokens = decodeSemanticTokens([0, 0, 5, 4, 0, 0, 6, 5], doc);
    expect(tokens).toEqual([{ from: 0, to: 5, cls: 'cm-st-keyword' }]);
  });
});

describe('buildSemanticDecorations (the path the editor ViewPlugin paints from)', () => {
  test('produces a non-empty decoration set for a representative source', () => {
    // 'value' (keyword) + 'Money' (type, declaration) on line 0 — two real semantic tokens.
    const decos = buildSemanticDecorations([0, 0, 5, 4, 0, 0, 6, 5, 0, DECLARATION], doc);
    expect(decos.size).toBe(2);
  });

  test('an empty stream yields Decoration.none (size 0) — static grammar stays authoritative', () => {
    expect(buildSemanticDecorations([], doc).size).toBe(0);
  });
});
