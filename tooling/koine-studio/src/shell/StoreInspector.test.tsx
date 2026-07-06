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

  test('raw snapshot tracks slices the curated rows do not subscribe to', () => {
    const store = createAppStore();
    const { container } = render(<StoreInspector store={store} />);

    // canUndo/canRedo (History slice) feed no curated row; the dump must still repaint when they
    // change — otherwise the "whole store" snapshot silently goes stale.
    act(() => {
      store.getState().setHistoryState({ canUndo: true, canRedo: false });
    });

    const raw = container.querySelector('[data-field="rawState"]')!.textContent!;
    expect(raw).toContain('"canUndo": true');
  });

  test('summarizes the assistant chat slice and tracks it live', () => {
    const store = createAppStore();
    const { container } = render(<StoreInspector store={store} />);

    // Defaults: idle transcript, no messages, nothing staged (— for the null change set).
    expect(field(container, 'chat')).toBe('idle, 0 messages, —');

    act(() => {
      store.getState().appendChatMessage({ role: 'user', content: 'add an Order aggregate' });
      store.getState().startChatTurn();
      store
        .getState()
        .stageChangeSet(
          [{ key: 'order.koi', relPath: 'order.koi', body: 'context Ordering', isNew: true }],
          {},
          null,
        );
    });

    expect(field(container, 'chat')).toBe('streaming, 1 message, reviewing');
  });

  test('has no accessibility violations', async () => {
    const store = createAppStore();
    const { container } = render(<StoreInspector store={store} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
