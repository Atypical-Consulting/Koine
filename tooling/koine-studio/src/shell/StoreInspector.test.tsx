import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, fireEvent, render } from '@testing-library/preact';
import { createAppStore } from '@/store/index';
import { StoreInspector } from '@/shell/StoreInspector';
import type { LspDiagnostic } from '@/lsp/lsp';
import { axe } from 'vitest-axe';

const field = (c: Element, name: string) =>
  c.querySelector(`[data-field="${name}"]`)!.textContent;

// Click the "Raw state" summary: happy-dom implements native <details> semantics, so the click flips
// `open` and dispatches the `toggle` event the component listens for (one call opens, the next closes).
const toggleRawState = (c: Element) => {
  act(() => {
    fireEvent.click(c.querySelector('.koi-store-inspector-raw summary')!);
  });
};

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

  test('renders no raw dump while the details is collapsed (the default)', () => {
    const store = createAppStore();
    const { container } = render(<StoreInspector store={store} />);

    // Collapsed by default: the summary is offered, but the dump — and the full-store serialization
    // behind it — must not exist until the user actually expands it (#1134).
    expect(container.querySelector('.koi-store-inspector-raw summary')).not.toBeNull();
    expect(container.querySelector('[data-field="rawState"]')).toBeNull();
  });

  test('exposes the full store as a raw-state snapshot once the details is opened', () => {
    const store = createAppStore();
    const { container } = render(<StoreInspector store={store} />);

    toggleRawState(container);

    const raw = container.querySelector('[data-field="rawState"]');
    expect(raw).not.toBeNull();
    // The whole store, not just the curated rows: a known data key shows up, and the
    // function-valued setters are filtered out so only state is dumped.
    expect(raw!.textContent).toContain('activeContext');
    expect(raw!.textContent).not.toContain('setActiveContext');
  });

  test('closing the details removes the dump again', () => {
    const store = createAppStore();
    const { container } = render(<StoreInspector store={store} />);

    toggleRawState(container); // open…
    expect(container.querySelector('[data-field="rawState"]')).not.toBeNull();

    toggleRawState(container); // …and close: the dump (and its whole-store subscription) unmounts.
    expect(container.querySelector('[data-field="rawState"]')).toBeNull();
  });

  // The open dump re-serializes at a bounded cadence (trailing-edge throttle, #1134), so these cases
  // drive the clock with fake timers to observe the deferred repaints deterministically.
  describe('open raw dump (throttled re-serialization)', () => {
    const THROTTLE_MS = 250;

    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    test('raw snapshot tracks slices the curated rows do not subscribe to', () => {
      const store = createAppStore();
      const { container } = render(<StoreInspector store={store} />);

      toggleRawState(container);

      // canUndo/canRedo (History slice) feed no curated row; the open dump must still repaint when
      // they change — otherwise the "whole store" snapshot silently goes stale. The repaint lands at
      // the throttle cadence, not synchronously.
      act(() => {
        store.getState().setHistoryState({ canUndo: true, canRedo: false });
      });
      act(() => {
        vi.advanceTimersByTime(THROTTLE_MS);
      });

      const raw = container.querySelector('[data-field="rawState"]')!.textContent!;
      expect(raw).toContain('"canUndo": true');
    });

    test('re-serializes at most once per window, landing on the latest state', () => {
      const store = createAppStore();
      const { container } = render(<StoreInspector store={store} />);

      toggleRawState(container);
      // Opening serializes immediately — the dump starts fresh, not deferred.
      expect(field(container, 'rawState')).toContain('"activeContext": "all"');

      act(() => {
        store.getState().setActiveContext('Ordering');
        store.getState().setActiveContext('Billing');
      });
      // Back-to-back updates do NOT repaint the dump inside the throttle window…
      expect(field(container, 'rawState')).toContain('"activeContext": "all"');
      act(() => {
        vi.advanceTimersByTime(THROTTLE_MS - 1);
      });
      expect(field(container, 'rawState')).toContain('"activeContext": "all"');

      // …then ONE trailing repaint lands the LATEST state once the window elapses.
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(field(container, 'rawState')).toContain('"activeContext": "Billing"');

      // The cadence is sustained: the next update is deferred by a fresh window again.
      act(() => {
        store.getState().setActiveContext('Shipping');
      });
      expect(field(container, 'rawState')).toContain('"activeContext": "Billing"');
      act(() => {
        vi.advanceTimersByTime(THROTTLE_MS);
      });
      expect(field(container, 'rawState')).toContain('"activeContext": "Shipping"');
    });

    test('closing the details with a refresh pending clears the timer and repaints nothing late', () => {
      const store = createAppStore();
      const { container } = render(<StoreInspector store={store} />);

      toggleRawState(container);
      act(() => {
        store.getState().setActiveContext('Ordering'); // arm a trailing refresh
      });
      expect(vi.getTimerCount()).toBeGreaterThan(0); // a refresh is pending…

      toggleRawState(container); // …and closing unmounts the dump with the timer still pending.
      expect(container.querySelector('[data-field="rawState"]')).toBeNull();
      expect(vi.getTimerCount()).toBe(0); // the pending timer was cleared, not leaked

      // Draining the clock after the unmount must neither throw nor resurrect the dump.
      expect(() =>
        act(() => {
          vi.advanceTimersByTime(THROTTLE_MS * 4);
        }),
      ).not.toThrow();
      expect(container.querySelector('[data-field="rawState"]')).toBeNull();
    });
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
