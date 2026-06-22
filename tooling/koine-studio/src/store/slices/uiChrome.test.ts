import { describe, expect, test } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { DEFAULT_MODE_ID } from '../../modes';
import { createUiChromeSlice, type UiChromeSlice } from './uiChrome';

const make = () => createStore<UiChromeSlice>((set, get) => createUiChromeSlice(set, get));

describe('uiChrome slice', () => {
  test('setMode keeps center consistent and falls back on an invalid id', () => {
    const s = make();
    s.getState().setMode('code');
    expect(s.getState().mode).toBe('code');
    expect(s.getState().center).toBe('technical');
    s.getState().setMode('not-a-mode');
    expect(s.getState().mode).toBe(DEFAULT_MODE_ID);
    expect(s.getState().center).toBe('visual');
  });

  test('tab setters are independent', () => {
    const s = make();
    s.getState().setBottom('events');
    s.getState().setRight('notes');
    expect(s.getState().bottom).toBe('events');
    expect(s.getState().right).toBe('notes');
  });
});
