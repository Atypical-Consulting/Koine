import { describe, expect, test, vi } from 'vitest';
import { act, fireEvent, render } from '@testing-library/preact';
import { axe } from 'vitest-axe';
import { HistoryControls, type HistoryControlsSlice } from './HistoryControls';
import type { ReadableStore } from '../host/store';

// A plain ReadableStore<HistoryControlsSlice> test double — koine-ui is store-free, so this mocks the
// contract directly instead of pulling in koine-studio's real Zustand store (which the ORIGINAL
// koine-studio-side test used via createAppStore()).
function createMockHistoryStore(initial: HistoryControlsSlice): ReadableStore<HistoryControlsSlice> & {
  set(next: HistoryControlsSlice): void;
} {
  let state = initial;
  const listeners = new Set<(state: HistoryControlsSlice) => void>();
  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(next) {
      state = next;
      for (const listener of listeners) listener(next);
    },
  };
}

const undoBtn = (c: Element) => c.querySelector('[data-role="undo"]') as HTMLButtonElement;
const redoBtn = (c: Element) => c.querySelector('[data-role="redo"]') as HTMLButtonElement;

describe('HistoryControls', () => {
  test('both buttons start disabled on a fresh store', () => {
    const store = createMockHistoryStore({ canUndo: false, canRedo: false });
    const { container } = render(
      <HistoryControls store={store} onUndo={() => {}} onRedo={() => {}} undoTitle="Undo" redoTitle="Redo" />,
    );
    expect(undoBtn(container).disabled).toBe(true);
    expect(redoBtn(container).disabled).toBe(true);
  });

  test('canUndo/canRedo toggle the disabled state', () => {
    const store = createMockHistoryStore({ canUndo: false, canRedo: false });
    const { container } = render(
      <HistoryControls store={store} onUndo={() => {}} onRedo={() => {}} undoTitle="Undo" redoTitle="Redo" />,
    );
    act(() => store.set({ canUndo: true, canRedo: false }));
    expect(undoBtn(container).disabled).toBe(false);
    expect(redoBtn(container).disabled).toBe(true);
    act(() => store.set({ canUndo: false, canRedo: true }));
    expect(undoBtn(container).disabled).toBe(true);
    expect(redoBtn(container).disabled).toBe(false);
  });

  test('clicks call the handlers', () => {
    const store = createMockHistoryStore({ canUndo: true, canRedo: true });
    const onUndo = vi.fn();
    const onRedo = vi.fn();
    const { container } = render(
      <HistoryControls store={store} onUndo={onUndo} onRedo={onRedo} undoTitle="Undo" redoTitle="Redo" />,
    );
    fireEvent.click(undoBtn(container));
    fireEvent.click(redoBtn(container));
    expect(onUndo).toHaveBeenCalledOnce();
    expect(onRedo).toHaveBeenCalledOnce();
  });

  test('has no accessibility violations', async () => {
    const store = createMockHistoryStore({ canUndo: true, canRedo: true });
    const { container } = render(
      <HistoryControls store={store} onUndo={() => {}} onRedo={() => {}} undoTitle="Undo" redoTitle="Redo" />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
