import { describe, expect, test } from 'vitest';
import { act, render } from '@testing-library/preact';
import { createAppStore } from '@/store/index';
import { DiagnosticsStripPanel } from '@/panels/DiagnosticsStripPanel';
import type { LspDiagnostic } from '@/lsp/lsp';

// One error diagnostic on (0-based) line 2, column 3 → the strip renders it 1-based as "error 3:4".
const err = (msg: string): LspDiagnostic => ({
  range: { start: { line: 2, character: 3 }, end: { line: 2, character: 4 } },
  message: msg,
  severity: 1,
});

describe('DiagnosticsStripPanel', () => {
  test('shows "clean" with no diagnostics, then the count + a row when one arrives', () => {
    const store = createAppStore();
    store.getState().setActiveUri('file:///a.koi');
    const { container } = render(
      <DiagnosticsStripPanel store={store} activeUri={() => 'file:///a.koi'} onGoto={() => {}} />,
    );

    // No diagnostics yet → the exact strip strings: count is "clean", body says "No diagnostics."
    expect(container.querySelector('[data-role="diag-count"]')!.textContent).toBe('clean');
    expect(container.querySelector('[data-role="diag-count"]')!.getAttribute('data-kind')).toBe('clean');
    expect(container.querySelector('[data-role="diag-body"] .diag-empty')!.textContent).toBe(
      'No diagnostics.',
    );

    // A pushed diagnostic re-renders the panel (flushed via act()): the count summarises it and a row
    // appears with the 1-based line:col + message, matching editorSession.renderStrip byte-for-byte.
    act(() => store.getState().setDiagnostics('file:///a.koi', [err('boom')]));
    expect(container.querySelector('[data-role="diag-count"]')!.textContent).toBe('1 error');
    expect(container.querySelector('[data-role="diag-count"]')!.getAttribute('data-kind')).toBe('error');
    const rows = container.querySelectorAll('[data-role="diag-body"] button.diag');
    expect(rows.length).toBe(1);
    expect(rows[0].textContent).toContain('error 3:4');
    expect(rows[0].textContent).toContain('boom');
  });
});
