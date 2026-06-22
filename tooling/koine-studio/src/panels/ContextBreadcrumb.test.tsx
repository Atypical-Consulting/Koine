import { describe, expect, test } from 'vitest';
import { act, render } from '@testing-library/preact';
import { createAppStore } from '../store/index';
import { ContextBreadcrumb } from './ContextBreadcrumb';

const scopeCrumb = (c: Element) => c.querySelector('[data-role="crumb-scope"]');
const elementCrumb = (c: Element) => c.querySelector('[data-role="crumb-element"]');

describe('ContextBreadcrumb', () => {
  test('shows "All contexts" and no element crumb on a fresh store', () => {
    const store = createAppStore();
    const { container } = render(<ContextBreadcrumb store={store} />);
    expect(scopeCrumb(container)!.textContent).toBe('All contexts');
    expect(elementCrumb(container)).toBeNull();
  });

  test('tracks the active context scope', () => {
    const store = createAppStore();
    const { container } = render(<ContextBreadcrumb store={store} />);
    act(() => store.getState().setActiveContext('Ordering'));
    expect(scopeCrumb(container)!.textContent).toBe('Ordering');
  });

  test('shows the selected element by its simple name (last dotted segment)', () => {
    const store = createAppStore();
    const { container } = render(<ContextBreadcrumb store={store} />);

    act(() => {
      store.getState().setActiveContext('Ordering');
      store.getState().setSelection({ qualifiedName: 'Ordering.Order', context: 'Ordering' });
    });
    expect(scopeCrumb(container)!.textContent).toBe('Ordering');
    expect(elementCrumb(container)!.textContent).toBe('Order');

    // Clearing the selection drops the element crumb but keeps the scope.
    act(() => store.getState().setSelection(null));
    expect(elementCrumb(container)).toBeNull();
    expect(scopeCrumb(container)!.textContent).toBe('Ordering');
  });
});
