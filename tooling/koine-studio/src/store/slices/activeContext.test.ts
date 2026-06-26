import { describe, expect, test, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { ALL_CONTEXTS } from '@/model/activeContext';
import { createActiveContextSlice, type ActiveContextSlice } from '@/store/slices/activeContext';

const make = () => createStore<ActiveContextSlice>((set, get) => createActiveContextSlice(set, get));

describe('activeContext slice', () => {
  test('defaults to ALL_CONTEXTS', () => {
    expect(make().getState().activeContext).toBe(ALL_CONTEXTS);
  });

  test('setActiveContext sets the scope; getState reflects it', () => {
    const s = make();
    s.getState().setActiveContext('Sales');
    expect(s.getState().activeContext).toBe('Sales');
  });

  test('subscribers see every change with the new scope', () => {
    const s = make();
    const fn = vi.fn();
    s.subscribe((state) => fn(state.activeContext));
    s.getState().setActiveContext('Sales');
    s.getState().setActiveContext('Inventory');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenNthCalledWith(1, 'Sales');
    expect(fn).toHaveBeenNthCalledWith(2, 'Inventory');
    expect(s.getState().activeContext).toBe('Inventory');
  });

  test('subscribers fire on change and stop after unsubscribe', () => {
    const s = make();
    const fn = vi.fn();
    const off = s.subscribe(fn);
    s.getState().setActiveContext('Sales');
    off();
    s.getState().setActiveContext('Inventory');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('re-selecting the same scope does not notify (no churn)', () => {
    const s = make();
    const fn = vi.fn();
    s.subscribe(fn);
    s.getState().setActiveContext('Sales');
    s.getState().setActiveContext('Sales');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('contexts default to empty and setContexts replaces the list', () => {
    const s = make();
    expect(s.getState().contexts).toEqual([]);
    s.getState().setContexts(['Sales', 'Billing']);
    expect(s.getState().contexts).toEqual(['Sales', 'Billing']);
  });

  test('setContexts with an equal list does not notify (no churn)', () => {
    const s = make();
    const fn = vi.fn();
    s.getState().setContexts(['Sales']);
    s.subscribe(fn);
    s.getState().setContexts(['Sales']); // same contents = no-op
    expect(fn).not.toHaveBeenCalled();
    s.getState().setContexts(['Sales', 'Billing']); // a real change notifies
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('navAltitude defaults to strategic and setNavAltitude flips it', () => {
    const s = make();
    expect(s.getState().navAltitude).toBe('strategic');
    s.getState().setNavAltitude('tactical');
    expect(s.getState().navAltitude).toBe('tactical');
    s.getState().setNavAltitude('strategic');
    expect(s.getState().navAltitude).toBe('strategic');
  });

  test('setNavAltitude with the same altitude does not notify (no churn)', () => {
    const s = make();
    const fn = vi.fn();
    s.subscribe((state) => fn(state.navAltitude));
    s.getState().setNavAltitude('strategic'); // already strategic = no-op
    expect(fn).not.toHaveBeenCalled();
    s.getState().setNavAltitude('tactical'); // a real change notifies
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenNthCalledWith(1, 'tactical');
  });
});
