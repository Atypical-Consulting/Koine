import { describe, expect, test } from 'vitest';
import { Text } from '@codemirror/state';
import { editsToChanges, lspPosToOffset, lspToCm } from '@/editor/positions';
import type { LspDiagnostic, TextEdit } from '@/lsp/lsp';

// These are the offset-math converters extracted from editor.ts. They run on a CodeMirror `Text`
// (constructable without a DOM/EditorView) so the off-by-one hazards — LSP's 0-based line vs Text's
// 1-based line(), character clamping to the line end, the zero-width `to <= from` nudge, and the
// descending edit sort that keeps multi-edit application from corrupting the buffer — are pinned here.

// "hello\nworld": line 1 = [0,5], the '\n' at offset 5, line 2 = [6,11], doc length 11.
const doc = Text.of(['hello', 'world']);

describe('lspPosToOffset', () => {
  test('maps a 0-based line/character to the document offset', () => {
    expect(lspPosToOffset(doc, 0, 0)).toBe(0);
    expect(lspPosToOffset(doc, 0, 2)).toBe(2);
    expect(lspPosToOffset(doc, 0, 5)).toBe(5);
    expect(lspPosToOffset(doc, 1, 0)).toBe(6);
    expect(lspPosToOffset(doc, 1, 3)).toBe(9);
  });

  test('clamps a character past the line end to the line end (not the next line)', () => {
    expect(lspPosToOffset(doc, 0, 99)).toBe(5); // end of line 1, NOT into line 2
  });

  test('clamps a negative character to the line start', () => {
    expect(lspPosToOffset(doc, 0, -3)).toBe(0);
  });

  test('clamps a line past the end to the last line', () => {
    expect(lspPosToOffset(doc, 99, 0)).toBe(6); // start of the last line
  });

  test('clamps a negative line to the first line', () => {
    expect(lspPosToOffset(doc, -5, 2)).toBe(2);
  });
});

const diag = (d: Partial<LspDiagnostic> & { range: LspDiagnostic['range'] }): LspDiagnostic => ({
  message: 'boom',
  ...d,
});
const range = (sl: number, sc: number, el: number, ec: number) => ({
  start: { line: sl, character: sc },
  end: { line: el, character: ec },
});

describe('lspToCm', () => {
  test('maps the LSP range to CodeMirror from/to offsets', () => {
    const cm = lspToCm(doc, diag({ range: range(0, 0, 0, 5) }));
    expect(cm.from).toBe(0);
    expect(cm.to).toBe(5);
  });

  test('severity 2 is a warning; everything else is an error', () => {
    expect(lspToCm(doc, diag({ range: range(0, 0, 0, 1), severity: 2 })).severity).toBe('warning');
    expect(lspToCm(doc, diag({ range: range(0, 0, 0, 1), severity: 1 })).severity).toBe('error');
    expect(lspToCm(doc, diag({ range: range(0, 0, 0, 1), severity: 3 })).severity).toBe('error');
    expect(lspToCm(doc, diag({ range: range(0, 0, 0, 1) })).severity).toBe('error'); // no severity
  });

  test('prefixes the message with the code when present', () => {
    expect(lspToCm(doc, diag({ range: range(0, 0, 0, 1), code: 'KOI001' })).message).toBe('KOI001: boom');
    expect(lspToCm(doc, diag({ range: range(0, 0, 0, 1), code: 42 })).message).toBe('42: boom');
    expect(lspToCm(doc, diag({ range: range(0, 0, 0, 1) })).message).toBe('boom');
  });

  test('nudges a zero-width range so to > from (a caret still highlights one char)', () => {
    const cm = lspToCm(doc, diag({ range: range(1, 2, 1, 2) }));
    expect(cm.from).toBe(8);
    expect(cm.to).toBe(9);
  });

  test('a zero-width range at the very end stays within the document length', () => {
    const cm = lspToCm(doc, diag({ range: range(1, 5, 1, 5) }));
    expect(cm.from).toBe(11);
    expect(cm.to).toBe(11); // cannot nudge past doc.length
  });
});

describe('editsToChanges', () => {
  test('converts a single edit to a change spec', () => {
    const edits: TextEdit[] = [{ range: range(0, 0, 0, 5), newText: 'HELLO' }];
    expect(editsToChanges(doc, edits)).toEqual([{ from: 0, to: 5, insert: 'HELLO' }]);
  });

  test('sorts edits by `from` descending so earlier edits do not shift later offsets', () => {
    const edits: TextEdit[] = [
      { range: range(0, 0, 0, 1), newText: 'A' }, // from 0
      { range: range(1, 0, 1, 1), newText: 'B' }, // from 6
    ];
    const changes = editsToChanges(doc, edits);
    expect(changes.map((c) => c.from)).toEqual([6, 0]); // descending
    expect(changes[0].insert).toBe('B');
  });

  test('returns an empty array for no edits', () => {
    expect(editsToChanges(doc, [])).toEqual([]);
  });
});
