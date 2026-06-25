import { describe, expect, test } from 'vitest';
import { diagnosticsSummary } from '@/diagnostics/diagnosticsSummary';
import type { LspDiagnostic } from '@/lsp/lsp';

const at = (severity: number | undefined): LspDiagnostic => ({
  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
  message: 'x',
  severity: severity as LspDiagnostic['severity'],
});

describe('diagnosticsSummary', () => {
  test('an empty set is clean with no parts', () => {
    expect(diagnosticsSummary([])).toEqual({ errors: 0, warnings: 0, kind: 'clean', parts: [] });
  });

  test('severity 1 and unset both count as errors', () => {
    const s = diagnosticsSummary([at(1), at(undefined)]);
    expect(s.errors).toBe(2);
    expect(s.kind).toBe('error');
    expect(s.parts).toEqual(['2 errors']);
  });

  test('severity 2 counts as a warning; kind is warn when there are no errors', () => {
    const s = diagnosticsSummary([at(2)]);
    expect(s).toMatchObject({ errors: 0, warnings: 1, kind: 'warn', parts: ['1 warning'] });
  });

  test('any error makes the kind error even alongside warnings, and parts are ordered errors-first', () => {
    const s = diagnosticsSummary([at(1), at(1), at(2)]);
    expect(s.kind).toBe('error');
    expect(s.parts).toEqual(['2 errors', '1 warning']);
  });

  test('info (3) and hint (4) are ignored entirely — an info/hint-only set is clean', () => {
    const s = diagnosticsSummary([at(3), at(4)]);
    expect(s).toEqual({ errors: 0, warnings: 0, kind: 'clean', parts: [] });
  });

  test('pluralisation: singular vs plural fragments', () => {
    expect(diagnosticsSummary([at(1)]).parts).toEqual(['1 error']);
    expect(diagnosticsSummary([at(2), at(2)]).parts).toEqual(['2 warnings']);
  });
});
