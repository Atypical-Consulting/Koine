import { describe, expect, test, vi } from 'vitest';
import { createSelectionBus, type SelectedElement } from './selection';

const el = (qualifiedName: string, context = qualifiedName.split('.')[0]): SelectedElement => ({
  qualifiedName,
  context,
});

describe('createSelectionBus', () => {
  test('starts empty; set then get returns the element', () => {
    const bus = createSelectionBus();
    expect(bus.get()).toBeNull();
    bus.set(el('Ordering.Order'));
    expect(bus.get()).toEqual({ qualifiedName: 'Ordering.Order', context: 'Ordering' });
  });

  test('set(null) clears the selection', () => {
    const bus = createSelectionBus();
    bus.set(el('Ordering.Order'));
    bus.set(null);
    expect(bus.get()).toBeNull();
  });

  test('subscribe fires on every change with the new value', () => {
    const bus = createSelectionBus();
    const fn = vi.fn();
    bus.subscribe(fn);
    bus.set(el('Ordering.Order'));
    bus.set(el('Inventory.Stock'));
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenNthCalledWith(1, { qualifiedName: 'Ordering.Order', context: 'Ordering' });
    expect(fn).toHaveBeenNthCalledWith(2, { qualifiedName: 'Inventory.Stock', context: 'Inventory' });
  });

  test('the unsubscribe handle stops further notifications', () => {
    const bus = createSelectionBus();
    const fn = vi.fn();
    const off = bus.subscribe(fn);
    bus.set(el('Ordering.Order'));
    off();
    bus.set(el('Inventory.Stock'));
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('multiple subscribers each receive the change', () => {
    const bus = createSelectionBus();
    const a = vi.fn();
    const b = vi.fn();
    bus.subscribe(a);
    bus.subscribe(b);
    bus.set(el('Ordering.Order'));
    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
  });
});
