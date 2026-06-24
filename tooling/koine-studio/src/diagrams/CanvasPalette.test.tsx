import { describe, expect, test, vi } from 'vitest';
import { act, fireEvent, render } from '@testing-library/preact';
import { createAppStore } from '@/store/index';
import { CanvasPalette } from '@/diagrams/CanvasPalette';
import { axe } from 'vitest-axe';

const btn = (c: Element, kind: string) => c.querySelector(`[data-kind="${kind}"]`) as HTMLButtonElement;
const annBtn = (c: Element, kind: string) => c.querySelector(`[data-annotation="${kind}"]`) as HTMLButtonElement;

describe('CanvasPalette', () => {
  test('renders the six round-trip constructs plus the coming-soon buttons', () => {
    const { container } = render(<CanvasPalette store={createAppStore()} onAdd={() => {}} onAddAnnotation={() => {}} />);
    for (const kind of ['entity', 'value', 'aggregate', 'event', 'enum', 'service']) {
      expect(btn(container, kind)).not.toBeNull();
    }
    // Coming-soon buttons are present and disabled (Service is a round-trip construct; Note/Group graduated
    // to active canvas-only annotations, so only Rule/Repository/Relation remain muted).
    const soon = container.querySelectorAll('.koi-palette-btn--soon');
    expect(soon.length).toBe(3);
    soon.forEach((b) => expect((b as HTMLButtonElement).disabled).toBe(true));
  });

  test('each construct button wears its shape-coded type icon (same glyph as the diagram nodes)', () => {
    const { container } = render(<CanvasPalette store={createAppStore()} onAdd={() => {}} onAddAnnotation={() => {}} />);
    for (const kind of ['entity', 'value', 'aggregate', 'event', 'enum', 'service']) {
      const icon = btn(container, kind).querySelector('.koi-model-icon');
      expect(icon).not.toBeNull();
      expect((icon as HTMLElement).dataset.construct).toBe(kind);
    }
  });

  test('construct buttons are disabled under "All contexts" and enabled once a context is active', () => {
    const store = createAppStore();
    const { container } = render(<CanvasPalette store={store} onAdd={() => {}} onAddAnnotation={() => {}} />);
    expect(btn(container, 'entity').disabled).toBe(true);
    act(() => store.getState().setActiveContext('Ordering'));
    expect(btn(container, 'entity').disabled).toBe(false);
  });

  test('under "All contexts", buttons enable when the model has exactly one context (the only home)', () => {
    const store = createAppStore(); // defaults to ALL_CONTEXTS
    const { container } = render(<CanvasPalette store={store} onAdd={() => {}} onAddAnnotation={() => {}} />);
    expect(btn(container, 'entity').disabled).toBe(true); // no contexts known yet
    act(() => store.getState().setContexts(['Ordering']));
    expect(btn(container, 'entity').disabled).toBe(false); // single context = unambiguous target
    act(() => store.getState().setContexts(['Ordering', 'Billing']));
    expect(btn(container, 'entity').disabled).toBe(true); // 2+ contexts = ambiguous, must pick
  });

  test('clicking an enabled construct calls onAdd with its kind', () => {
    const store = createAppStore();
    act(() => store.getState().setActiveContext('Ordering'));
    const onAdd = vi.fn();
    const { container } = render(<CanvasPalette store={store} onAdd={onAdd} onAddAnnotation={() => {}} />);
    fireEvent.click(btn(container, 'aggregate'));
    expect(onAdd).toHaveBeenCalledWith('aggregate');
  });

  test('the Note and Group annotation buttons are active (not context-gated) and fire onAddAnnotation', () => {
    const store = createAppStore(); // ALL_CONTEXTS, no contexts → round-trip constructs are disabled…
    const onAddAnnotation = vi.fn();
    const { container } = render(<CanvasPalette store={store} onAdd={() => {}} onAddAnnotation={onAddAnnotation} />);
    // …but the canvas-only annotations are enabled regardless (they have no `.koi` home context).
    expect(btn(container, 'entity').disabled).toBe(true);
    expect(annBtn(container, 'note')).not.toBeNull();
    expect(annBtn(container, 'note').disabled).toBe(false);
    expect(annBtn(container, 'group').disabled).toBe(false);

    fireEvent.click(annBtn(container, 'note'));
    expect(onAddAnnotation).toHaveBeenCalledWith('note');
    fireEvent.click(annBtn(container, 'group'));
    expect(onAddAnnotation).toHaveBeenCalledWith('group');
  });

  test('has no accessibility violations', async () => {
    const store = createAppStore();
    act(() => store.getState().setActiveContext('Ordering'));
    const { container } = render(<CanvasPalette store={store} onAdd={() => {}} onAddAnnotation={() => {}} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
