import { describe, expect, test } from 'vitest';
import { badgeCounts, createDiagCountGate } from '@/diagnostics/diagCountGate';
import type { LspDiagnostic } from '@/lsp/lsp';

const at = (severity: number | undefined, message = 'x'): LspDiagnostic => ({
  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
  message,
  severity: severity as LspDiagnostic['severity'],
});
const err = at(1, 'boom');
const warn = at(2, 'careful');

describe('createDiagCountGate', () => {
  test('a clean first push for a never-seen uri is NOT a change (no badge appears)', () => {
    const gate = createDiagCountGate();
    expect(gate.changed('file:///a.koi', [])).toBe(false);
  });

  test('counts going up is a change; the same counts again is not', () => {
    const gate = createDiagCountGate();
    expect(gate.changed('file:///a.koi', [err])).toBe(true);
    expect(gate.changed('file:///a.koi', [err])).toBe(false);
  });

  test('counts changing (errors cleared, warning added) is a change each time', () => {
    const gate = createDiagCountGate();
    gate.changed('file:///a.koi', [err]); // -> 1 error
    expect(gate.changed('file:///a.koi', [warn])).toBe(true); // 0 errors, 1 warning
    expect(gate.changed('file:///a.koi', [])).toBe(true); // back to clean
    expect(gate.changed('file:///a.koi', [])).toBe(false); // still clean
  });

  test('each uri is tracked independently', () => {
    const gate = createDiagCountGate();
    expect(gate.changed('file:///a.koi', [err])).toBe(true);
    expect(gate.changed('file:///b.koi', [err])).toBe(true);
    expect(gate.changed('file:///a.koi', [err])).toBe(false);
  });

  test('reset() forgets all uris so the next push re-renders (e.g. after clearDiagnostics on a folder reopen)', () => {
    const gate = createDiagCountGate();
    gate.changed('file:///a.koi', [err]);
    gate.reset();
    // Same counts as before, but the slice was cleared meanwhile — the badge must be redrawn.
    expect(gate.changed('file:///a.koi', [err])).toBe(true);
  });

  test('forget(uri) forgets one uri (drop/rename), leaving others tracked', () => {
    const gate = createDiagCountGate();
    gate.changed('file:///a.koi', [err]);
    gate.changed('file:///b.koi', [err]);
    gate.forget('file:///a.koi');
    expect(gate.changed('file:///a.koi', [err])).toBe(true); // forgotten → re-render
    expect(gate.changed('file:///b.koi', [err])).toBe(false); // still tracked → unchanged
  });

  test('classifies severities like the file-tree badge: only severity 2 is a warning, everything else (incl. info/hint 3/4 and unset) is an error', () => {
    expect(badgeCounts([at(1), at(2), at(3), at(4), at(undefined)])).toEqual({ errors: 4, warnings: 1 });
    // An info/hint-only push for a clean file IS a change, because the badge counts it as an error.
    const gate = createDiagCountGate();
    expect(gate.changed('file:///a.koi', [at(3)])).toBe(true);
  });
});
