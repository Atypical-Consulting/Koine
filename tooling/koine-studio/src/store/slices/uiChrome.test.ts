import { describe, expect, test } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { createUiChromeSlice, DEFAULT_CENTER, isValidCenter, type UiChromeSlice } from '@/store/slices/uiChrome';

const make = () => createStore<UiChromeSlice>((set, get) => createUiChromeSlice(set, get));

describe('uiChrome slice', () => {
  test('center defaults to Visual and setCenter switches it', () => {
    const s = make();
    expect(s.getState().center).toBe(DEFAULT_CENTER);
    expect(DEFAULT_CENTER).toBe('visual');
    s.getState().setCenter('technical');
    expect(s.getState().center).toBe('technical');
  });

  test('isValidCenter accepts real panes and rejects everything else', () => {
    expect(isValidCenter('visual')).toBe(true);
    expect(isValidCenter('technical')).toBe(true);
    expect(isValidCenter('docs')).toBe(true);
    expect(isValidCenter('domain')).toBe(false); // an old persisted mode id is not a center
    expect(isValidCenter('')).toBe(false);
  });

  test('tab setters are independent', () => {
    const s = make();
    s.getState().setBottom('events');
    s.getState().setRight('notes');
    expect(s.getState().bottom).toBe('events');
    expect(s.getState().right).toBe('notes');
  });

  test('outlineFilter defaults to empty and is set independently (it survives panel remounts)', () => {
    const s = make();
    expect(s.getState().outlineFilter).toBe('');
    s.getState().setOutlineFilter('Order');
    expect(s.getState().outlineFilter).toBe('Order');
    s.getState().setOutlineFilter('');
    expect(s.getState().outlineFilter).toBe('');
  });
});
