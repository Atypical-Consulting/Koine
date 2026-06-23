import { describe, expect, test } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { createHistorySlice, type HistorySlice } from '@/store/slices/history';

const make = () => createStore<HistorySlice>((set, get) => createHistorySlice(set, get));

describe('history slice', () => {
  test('starts with both disabled', () => {
    const s = make();
    expect(s.getState().canUndo).toBe(false);
    expect(s.getState().canRedo).toBe(false);
  });

  test('setHistoryState updates both flags', () => {
    const s = make();
    s.getState().setHistoryState({ canUndo: true, canRedo: false });
    expect(s.getState().canUndo).toBe(true);
    expect(s.getState().canRedo).toBe(false);
    s.getState().setHistoryState({ canUndo: false, canRedo: true });
    expect(s.getState().canUndo).toBe(false);
    expect(s.getState().canRedo).toBe(true);
  });
});
