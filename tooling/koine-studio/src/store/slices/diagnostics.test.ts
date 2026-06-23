import { describe, expect, test } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { createDiagnosticsSlice, type DiagnosticsSlice } from '@/store/slices/diagnostics';
import type { LspDiagnostic } from '@/lsp/lsp';

const diag = (msg: string): LspDiagnostic =>
  ({ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message: msg, severity: 1 });

const make = () => createStore<DiagnosticsSlice>((set, get) => createDiagnosticsSlice(set, get));

describe('diagnostics slice', () => {
  test('setDiagnostics then diagnosticsFor returns the cached list; unknown uri is empty', () => {
    const s = make();
    expect(s.getState().diagnosticsFor('file:///a.koi')).toEqual([]);
    s.getState().setDiagnostics('file:///a.koi', [diag('boom')]);
    expect(s.getState().diagnosticsFor('file:///a.koi')).toEqual([diag('boom')]);
  });

  test('renameDiagnostics moves the entry; dropDiagnostics forgets it; clear empties all', () => {
    const s = make();
    s.getState().setDiagnostics('file:///a.koi', [diag('x')]);
    s.getState().renameDiagnostics('file:///a.koi', 'file:///b.koi');
    expect(s.getState().diagnosticsFor('file:///a.koi')).toEqual([]);
    expect(s.getState().diagnosticsFor('file:///b.koi')).toEqual([diag('x')]);
    s.getState().dropDiagnostics('file:///b.koi');
    expect(s.getState().diagnosticsFor('file:///b.koi')).toEqual([]);
    s.getState().setDiagnostics('file:///c.koi', [diag('y')]);
    s.getState().clearDiagnostics();
    expect(s.getState().diagnosticsFor('file:///c.koi')).toEqual([]);
  });
});
