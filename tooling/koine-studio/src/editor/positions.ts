// Offset-math converters between the LSP wire model (0-based {line,character}) and CodeMirror
// document offsets. These run on a CodeMirror `Text` (not an `EditorView`), so they carry no DOM
// dependency and are unit-tested directly (positions.test.ts). editor.ts wraps them by passing
// `view.state.doc`. The clamping + zero-width nudge + descending edit sort live here, once.

import type { Text } from '@codemirror/state';
import type { Diagnostic as CmDiagnostic } from '@codemirror/lint';
import type { LspDiagnostic, TextEdit } from '@/lsp/lsp';
import { severityErrorOrWarning } from '@/lsp/severity';

/** Convert a 0-based LSP {line,character} to a CodeMirror document offset (clamped to doc/line bounds). */
export function lspPosToOffset(doc: Text, line: number, character: number): number {
  const ln = Math.min(Math.max(line, 0), doc.lines - 1) + 1; // doc.line() is 1-based
  const lineInfo = doc.line(ln);
  return Math.min(lineInfo.from + Math.max(character, 0), lineInfo.to);
}

/** Map a 0-based LSP diagnostic to a CodeMirror diagnostic (offset-based). */
export function lspToCm(doc: Text, d: LspDiagnostic): CmDiagnostic {
  const clampLine0 = (l: number) => Math.min(Math.max(l, 0), doc.lines - 1); // LSP line is 0-based
  const startLine = doc.line(clampLine0(d.range.start.line) + 1); // doc.line() is 1-based
  const endLine = doc.line(clampLine0(d.range.end.line) + 1);
  const from = Math.min(startLine.from + d.range.start.character, startLine.to);
  let to = Math.min(endLine.from + d.range.end.character, endLine.to);
  if (to <= from) to = Math.min(from + 1, doc.length);
  return {
    from,
    to,
    severity: severityErrorOrWarning(d.severity),
    message: (d.code != null ? d.code + ': ' : '') + d.message,
  };
}

/**
 * Convert LSP TextEdits to CodeMirror change specs, sorted by `from` descending so earlier edits
 * don't shift the offsets of later ones when applied as a single transaction.
 */
export function editsToChanges(doc: Text, edits: TextEdit[]): { from: number; to: number; insert: string }[] {
  return edits
    .map((e) => ({
      from: lspPosToOffset(doc, e.range.start.line, e.range.start.character),
      to: lspPosToOffset(doc, e.range.end.line, e.range.end.character),
      insert: e.newText,
    }))
    .sort((a, b) => b.from - a.from);
}
