import { describe, expect, test } from 'vitest';
import { severityCategory, severityErrorOrWarning } from '@/lsp/severity';

// The single canonical mapping for the LSP DiagnosticSeverity number. Four call sites used to hard-code
// `severity === 2 ? 'warning' : 'error'` / `severity === 1 || severity == null`; they now derive from
// here. The two consumers differ ON PURPOSE: the status-bar summary keeps a separate info/hint tier and
// drops it, while the file-tree badge / CodeMirror gutter / AI context have no such tier and surface
// anything-but-warning as an error — `severityErrorOrWarning` names exactly that collapse.

describe('severityCategory', () => {
  test('maps the LSP DiagnosticSeverity enum (1=error, 2=warning, 3=info, 4=hint)', () => {
    expect(severityCategory(1)).toBe('error');
    expect(severityCategory(2)).toBe('warning');
    expect(severityCategory(3)).toBe('info');
    expect(severityCategory(4)).toBe('hint');
  });

  test('treats an unset or out-of-range severity as an error', () => {
    expect(severityCategory(undefined)).toBe('error');
    expect(severityCategory(0)).toBe('error');
    expect(severityCategory(99)).toBe('error');
  });
});

describe('severityErrorOrWarning', () => {
  test('collapses everything that is not severity 2 to error (no info/hint tier)', () => {
    expect(severityErrorOrWarning(1)).toBe('error');
    expect(severityErrorOrWarning(2)).toBe('warning');
    expect(severityErrorOrWarning(3)).toBe('error');
    expect(severityErrorOrWarning(4)).toBe('error');
    expect(severityErrorOrWarning(undefined)).toBe('error');
  });
});
