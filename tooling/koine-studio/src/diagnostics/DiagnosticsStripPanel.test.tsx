import { describe, expect, test, vi } from 'vitest';
import { act, render } from '@testing-library/preact';
import { createAppStore } from '@/store/index';
import { DiagnosticsStripPanel } from '@/diagnostics/DiagnosticsStripPanel';
import type { LspDiagnostic } from '@/lsp/lsp';
import { axe } from 'vitest-axe';

// One error diagnostic on (0-based) line 2, column 3 → the strip renders it 1-based as "error 3:4".
const err = (msg: string): LspDiagnostic => ({
  range: { start: { line: 2, character: 3 }, end: { line: 2, character: 4 } },
  message: msg,
  severity: 1,
});

describe('DiagnosticsStripPanel', () => {
  test('shows "clean" with no diagnostics, then the count + a row when one arrives', () => {
    const store = createAppStore();
    store.getState().setActive('file:///a.koi');
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

  test('has no accessibility violations', async () => {
    const store = createAppStore();
    store.getState().setActive('file:///a.koi');
    const { container } = render(
      <DiagnosticsStripPanel store={store} activeUri={() => 'file:///a.koi'} onGoto={() => {}} />,
    );
    act(() => store.getState().setDiagnostics('file:///a.koi', [err('boom')]));
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('DiagnosticsStripPanel — scope to context (ADR 0009 / #1188)', () => {
  const scope = (onOpen = vi.fn()) => ({ uriLabel: (u: string) => u.split('/').pop()!, onOpen });

  test('a real active context shows THAT context\'s files — following the context, not the active file', () => {
    const store = createAppStore();
    // The OPEN file is Ordering, but the scope is Billing — Problems must follow the CONTEXT, not the file.
    store.getState().setActive('file:///Ordering.koi');
    store.getState().setActiveContext('Billing');
    const onOpen = vi.fn();
    const { container } = render(
      <DiagnosticsStripPanel
        store={store}
        activeUri={() => 'file:///Ordering.koi'}
        onGoto={() => {}}
        scope={scope(onOpen)}
      />,
    );
    act(() => {
      store.getState().setDiagnostics('file:///Billing.koi', [err('billing boom')]);
      store.getState().setDiagnostics('file:///Ordering.koi', [err('ordering boom')]);
    });

    const rows = container.querySelectorAll('[data-role="diag-body"] button.diag');
    expect(rows.length).toBe(1); // only Billing's — Ordering is a different context, and it's the OPEN file
    expect(rows[0].textContent).toContain('Billing.koi'); // scoped rows are file-labelled
    expect(rows[0].textContent).toContain('billing boom');
    expect(rows[0].textContent).not.toContain('ordering boom');
    expect(container.querySelector('[data-role="diag-count"]')!.textContent).toBe('1 error');

    // A scoped row opens ITS file (not the active one) at the diagnostic's range.
    (rows[0] as HTMLButtonElement).click();
    expect(onOpen).toHaveBeenCalledWith('file:///Billing.koi', err('billing boom').range);
  });

  test('mirrors its count into an injected countEl (the Problems tab pill) — scoped with the strip (#1203)', () => {
    const store = createAppStore();
    // The OPEN file is Ordering, but the scope is Billing — the pill must mirror the SCOPED strip.
    store.getState().setActive('file:///Ordering.koi');
    store.getState().setActiveContext('Billing');
    const countEl = document.createElement('span');
    const { container } = render(
      <DiagnosticsStripPanel
        store={store}
        activeUri={() => 'file:///Ordering.koi'}
        onGoto={() => {}}
        scope={scope()}
        countEl={countEl}
      />,
    );

    // Mounted clean: the pill mirrors the strip's empty state (same 'clean' sentinel + data-kind).
    expect(countEl.textContent).toBe('clean');
    expect(countEl.dataset.kind).toBe('clean');

    act(() => {
      store.getState().setDiagnostics('file:///Billing.koi', [err('billing boom')]);
      store.getState().setDiagnostics('file:///Ordering.koi', [err('ordering boom')]);
    });

    // The pill shows Billing's (the scoped context's) count — NOT the open file's — and stays
    // byte-identical to the strip's own count element: one source, two mirrors.
    expect(countEl.textContent).toBe('1 error');
    expect(countEl.dataset.kind).toBe('error');
    expect(countEl.textContent).toBe(container.querySelector('[data-role="diag-count"]')!.textContent);
    expect(countEl.dataset.kind).toBe(
      container.querySelector('[data-role="diag-count"]')!.getAttribute('data-kind'),
    );
  });

  test('All contexts (with a scope provided) still shows only the ACTIVE file, byte-for-byte', () => {
    const store = createAppStore(); // activeContext defaults to ALL_CONTEXTS
    store.getState().setActive('file:///Ordering.koi');
    const { container } = render(
      <DiagnosticsStripPanel
        store={store}
        activeUri={() => 'file:///Ordering.koi'}
        onGoto={() => {}}
        scope={scope()}
      />,
    );
    act(() => {
      store.getState().setDiagnostics('file:///Billing.koi', [err('billing')]);
      store.getState().setDiagnostics('file:///Ordering.koi', [err('ordering')]);
    });

    const rows = container.querySelectorAll('[data-role="diag-body"] button.diag');
    expect(rows.length).toBe(1);
    expect(rows[0].textContent).toContain('ordering'); // the active file
    expect(rows[0].textContent).not.toContain('billing');
    // Unscoped rows are NOT file-labelled — the strip is byte-for-byte the old active-file strip.
    expect(rows[0].textContent!.startsWith('error ')).toBe(true);
  });
});
