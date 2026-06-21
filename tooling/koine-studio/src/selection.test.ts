import { describe, expect, test, vi } from 'vitest';
import { createSelectionBus, type SelectedElement } from './selection';
import type { SourceSpan } from './lsp';

const span = (line: number): SourceSpan => ({
  file: 'file:///Ordering.koi',
  line,
  column: 1,
  endLine: line,
  endColumn: 10,
  offset: 0,
  length: 9,
});

const order = (): SelectedElement => ({ qualifiedName: 'Ordering.Order', context: 'Ordering', span: span(3) });

describe('createSelectionBus', () => {
  test('starts empty', () => {
    expect(createSelectionBus().get()).toBeNull();
  });

  test('set then get returns the element', () => {
    const bus = createSelectionBus();
    bus.set(order());
    expect(bus.get()).toEqual(order());
  });

  test('subscribe fires on change with the new selection', () => {
    const bus = createSelectionBus();
    const seen: (SelectedElement | null)[] = [];
    bus.subscribe((e) => seen.push(e));
    bus.set(order());
    bus.set(null);
    expect(seen).toEqual([order(), null]);
  });

  test('unsubscribe stops further notifications', () => {
    const bus = createSelectionBus();
    const fn = vi.fn();
    const off = bus.subscribe(fn);
    bus.set(order());
    off();
    bus.set(null);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('setting the same selection again still notifies (re-selection is meaningful)', () => {
    const bus = createSelectionBus();
    const fn = vi.fn();
    bus.subscribe(fn);
    bus.set(order());
    bus.set(order());
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
