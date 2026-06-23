import { describe, expect, test, vi } from 'vitest';
import { act, fireEvent, render } from '@testing-library/preact';
import { createAppStore } from '@/store/index';
import { CanvasPalette } from '@/diagrams/CanvasPalette';
import { axe } from 'vitest-axe';

const btn = (c: Element, kind: string) => c.querySelector(`[data-kind="${kind}"]`) as HTMLButtonElement;

describe('CanvasPalette', () => {
  test('renders the five round-trip constructs plus the coming-soon buttons', () => {
    const { container } = render(<CanvasPalette store={createAppStore()} onAdd={() => {}} />);
    for (const kind of ['entity', 'value', 'aggregate', 'event', 'enum']) {
      expect(btn(container, kind)).not.toBeNull();
    }
    // Coming-soon buttons are present and disabled.
    const soon = container.querySelectorAll('.koi-palette-btn--soon');
    expect(soon.length).toBe(6);
    soon.forEach((b) => expect((b as HTMLButtonElement).disabled).toBe(true));
  });

  test('construct buttons are disabled under "All contexts" and enabled once a context is active', () => {
    const store = createAppStore();
    const { container } = render(<CanvasPalette store={store} onAdd={() => {}} />);
    expect(btn(container, 'entity').disabled).toBe(true);
    act(() => store.getState().setActiveContext('Ordering'));
    expect(btn(container, 'entity').disabled).toBe(false);
  });

  test('clicking an enabled construct calls onAdd with its kind', () => {
    const store = createAppStore();
    act(() => store.getState().setActiveContext('Ordering'));
    const onAdd = vi.fn();
    const { container } = render(<CanvasPalette store={store} onAdd={onAdd} />);
    fireEvent.click(btn(container, 'aggregate'));
    expect(onAdd).toHaveBeenCalledWith('aggregate');
  });

  test('has no accessibility violations', async () => {
    const store = createAppStore();
    act(() => store.getState().setActiveContext('Ordering'));
    const { container } = render(<CanvasPalette store={store} onAdd={() => {}} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
