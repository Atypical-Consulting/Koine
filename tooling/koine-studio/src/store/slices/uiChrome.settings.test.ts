import { describe, it, expect } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { createUiChromeSlice, isValidCenter, type UiChromeSlice } from './uiChrome';

describe('uiChrome settings center view', () => {
  it('accepts "settings" as a center value via setCenter', () => {
    const store = createStore<UiChromeSlice>((set, get) => createUiChromeSlice(set, get));
    store.getState().setCenter('settings');
    expect(store.getState().center).toBe('settings');
  });

  it('isValidCenter rejects "settings" so the transient view is never restored on reload', () => {
    expect(isValidCenter('settings')).toBe(false);
    expect(isValidCenter('visual')).toBe(true);
  });
});
