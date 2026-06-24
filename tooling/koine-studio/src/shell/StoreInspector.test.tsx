import { describe, expect, test } from 'vitest';
import { act, render } from '@testing-library/preact';
import { createAppStore } from '@/store/index';
import { StoreInspector } from '@/shell/StoreInspector';
import type { LspDiagnostic } from '@/lsp/lsp';
import { axe } from 'vitest-axe';

const field = (c: Element, name: string) =>
  c.querySelector(`[data-field="${name}"]`)!.textContent;

const err: LspDiagnostic = {
  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
  message: 'boom',
  severity: 1,
};

describe('StoreInspector', () => {
  test('renders the live store fields with their defaults', () => {
    const store = createAppStore();
    const { container } = render(<StoreInspector store={store} />);
    expect(field(container, 'activeContext')).toBe('all');
    expect(field(container, 'selection')).toBe('—');
    expect(field(container, 'center')).toBe('visual');
    expect(field(container, 'dirty')).toBe('0');
  });

  test('reflects selection, scope and diagnostics changes live', () => {
    const store = createAppStore();
    const { container } = render(<StoreInspector store={store} />);

    act(() => {
      store.getState().setActiveContext('Ordering');
      store.getState().setSelection({ qualifiedName: 'Ordering.Order', context: 'Ordering' });
      store.getState().setDiagnostics('file:///a.koi', [err]);
    });

    expect(field(container, 'activeContext')).toBe('Ordering');
    expect(field(container, 'selection')).toBe('Ordering.Order');
    expect(field(container, 'problems')).toContain('1 error');
  });

  test('exposes the full store as a collapsible raw-state snapshot', () => {
    const store = createAppStore();
    const { container } = render(<StoreInspector store={store} />);

    const raw = container.querySelector('[data-field="rawState"]');
    expect(raw).not.toBeNull();
    // The whole store, not just the curated rows: a known data key shows up, and the
    // function-valued setters are filtered out so only state is dumped.
    expect(raw!.textContent).toContain('activeContext');
    expect(raw!.textContent).not.toContain('setActiveContext');
  });

  test('has no accessibility violations', async () => {
    const store = createAppStore();
    const { container } = render(<StoreInspector store={store} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
