import { describe, expect, test, vi } from 'vitest';
import { act, render } from '@testing-library/preact';
import { axe } from 'vitest-axe';
import {
  DiagnosticsStripPanel,
  type DiagnosticsStripRow,
  type DiagnosticsStripSlice,
} from './DiagnosticsStripPanel';
import { createTestReadableStore } from '../host/storeTestUtils';

// The shared ReadableStore<T> test double (host/storeTestUtils) — koine-ui is store-free, so it mocks
// the contract directly instead of pulling in koine-studio's real Zustand store (which the ORIGINAL
// koine-studio-side test used via createAppStore() + setDiagnostics). The scoping/counting derivation
// (which files belong to the active context, the count wording) is the host adapter's job, pinned in
// koine-studio's readableStores.test.ts; this file covers only what the component renders from a slice.

const CLEAN: DiagnosticsStripSlice = { scoped: false, rows: [], count: 'clean', kind: 'clean' };

// One error row on (0-based) line 2, column 3 → the strip renders it 1-based as "error 3:4".
const errRow = (msg: string, overrides: Partial<DiagnosticsStripRow> = {}): DiagnosticsStripRow => ({
  uri: 'file:///a.koi',
  severity: 'error',
  range: { start: { line: 2, character: 3 }, end: { line: 2, character: 4 } },
  message: msg,
  ...overrides,
});

describe('DiagnosticsStripPanel', () => {
  test('shows "clean" with no rows, then the count + a row when the slice changes', () => {
    const store = createTestReadableStore<DiagnosticsStripSlice>(CLEAN);
    const { container } = render(<DiagnosticsStripPanel store={store} onGoto={() => {}} />);

    // No diagnostics yet → the exact strip strings: count is "clean", body says "No diagnostics."
    expect(container.querySelector('[data-role="diag-count"]')!.textContent).toBe('clean');
    expect(container.querySelector('[data-role="diag-count"]')!.getAttribute('data-kind')).toBe('clean');
    expect(container.querySelector('[data-role="diag-body"] .diag-empty')!.textContent).toBe(
      'No diagnostics.',
    );

    // A host notification re-renders the panel (flushed via act()): the count and a row appear with the
    // 1-based line:col + message, matching editorSession.renderStrip byte-for-byte.
    act(() => store.set({ scoped: false, rows: [errRow('boom')], count: '1 error', kind: 'error' }));
    expect(container.querySelector('[data-role="diag-count"]')!.textContent).toBe('1 error');
    expect(container.querySelector('[data-role="diag-count"]')!.getAttribute('data-kind')).toBe('error');
    const rows = container.querySelectorAll('[data-role="diag-body"] button.diag');
    expect(rows.length).toBe(1);
    expect(rows[0].textContent).toBe('error 3:4  boom');
    expect(rows[0].classList.contains('diag-err')).toBe(true);
  });

  test('a warning row uses the warn class/word and a code is prefixed "CODE: "', () => {
    const store = createTestReadableStore<DiagnosticsStripSlice>({
      scoped: false,
      rows: [errRow('meh', { severity: 'warning', code: 'KOI042' })],
      count: '1 warning',
      kind: 'warn',
    });
    const { container } = render(<DiagnosticsStripPanel store={store} onGoto={() => {}} />);

    const row = container.querySelector('[data-role="diag-body"] button.diag')!;
    expect(row.classList.contains('diag-warn')).toBe(true);
    expect(row.textContent).toBe('warn 3:4  KOI042: meh');
  });

  test('clicking an unscoped row calls onGoto with the 1-based line:col', () => {
    const onGoto = vi.fn();
    const store = createTestReadableStore<DiagnosticsStripSlice>({
      scoped: false,
      rows: [errRow('boom')],
      count: '1 error',
      kind: 'error',
    });
    const { container } = render(<DiagnosticsStripPanel store={store} onGoto={onGoto} />);

    (container.querySelector('button.diag') as HTMLButtonElement).click();
    expect(onGoto).toHaveBeenCalledWith(3, 4);
  });

  test('a scoped row is file-labelled and opens ITS file via onOpen (ADR 0009 / #1188)', () => {
    const onOpen = vi.fn();
    const row = errRow('billing boom', { uri: 'file:///Billing.koi', label: 'Billing.koi' });
    const store = createTestReadableStore<DiagnosticsStripSlice>({ scoped: true, rows: [row], count: '1 error', kind: 'error' });
    const { container } = render(
      <DiagnosticsStripPanel store={store} onGoto={() => {}} onOpen={onOpen} />,
    );

    const btn = container.querySelector('button.diag') as HTMLButtonElement;
    // A scoped row prefixes its file so a cross-file problem is attributable…
    expect(btn.textContent).toBe('Billing.koi  error 3:4  billing boom');
    // …and opens that file (not the active one) at the diagnostic's range.
    btn.click();
    expect(onOpen).toHaveBeenCalledWith('file:///Billing.koi', row.range);
  });

  test('renders only within its subtree — no imperative host-DOM writes', () => {
    // The component is pure: it reads the store and renders within its own container via Preact
    // (#1406 — removed the old countEl host-element mirror). The host adapter mirrors the pill
    // host-side by subscribing to the same store.
    const store = createTestReadableStore<DiagnosticsStripSlice>(CLEAN);
    const { container } = render(<DiagnosticsStripPanel store={store} onGoto={() => {}} />);

    // The component's count and kind are rendered in its own element, not written to external DOM.
    expect(container.querySelector('[data-role="diag-count"]')!.textContent).toBe('clean');
    expect(container.querySelector('[data-role="diag-count"]')!.getAttribute('data-kind')).toBe('clean');

    act(() => store.set({ scoped: false, rows: [errRow('boom')], count: '1 error', kind: 'error' }));

    // After a store update, the strip's own elements update in its subtree.
    expect(container.querySelector('[data-role="diag-count"]')!.textContent).toBe('1 error');
    // The component only mutates its own DOM, never external host elements (no countEl imperative writes).
  });

  test('a top-level re-render reflects getState() fresh, without a store notification', () => {
    // The host (editorSession's paintActive) re-renders the mounted panel SYNCHRONOUSLY on an
    // active-file switch — a change the store may not notify for (the adapter's selector reads the
    // live activeUri). The panel must re-read getState() during render, not serve a cached slice.
    const store = createTestReadableStore<DiagnosticsStripSlice>(CLEAN);
    const ui = () => <DiagnosticsStripPanel store={store} onGoto={() => {}} />;
    const { container, rerender } = render(ui());
    expect(container.querySelector('[data-role="diag-count"]')!.textContent).toBe('clean');

    store.silentSet({ scoped: false, rows: [errRow('boom')], count: '1 error', kind: 'error' });
    act(() => rerender(ui()));
    expect(container.querySelector('[data-role="diag-count"]')!.textContent).toBe('1 error');
    expect(container.querySelectorAll('button.diag').length).toBe(1);
  });

  test('has no accessibility violations', async () => {
    const store = createTestReadableStore<DiagnosticsStripSlice>({
      scoped: false,
      rows: [errRow('boom')],
      count: '1 error',
      kind: 'error',
    });
    const { container } = render(<DiagnosticsStripPanel store={store} onGoto={() => {}} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
