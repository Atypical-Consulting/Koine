import { describe, expect, test, vi } from 'vitest';
import { act, fireEvent, render } from '@testing-library/preact';
import { axe } from 'vitest-axe';
import { HistoryControls, type HistoryControlsSlice } from './HistoryControls';
import { createTestReadableStore } from '../host/storeTestUtils';

// The shared ReadableStore<T> test double (host/storeTestUtils) — koine-ui is store-free, so it mocks
// the contract directly instead of pulling in koine-studio's real Zustand store (which the ORIGINAL
// koine-studio-side test used via createAppStore()).

const undoBtn = (c: Element) => c.querySelector('[data-role="undo"]') as HTMLButtonElement;
const redoBtn = (c: Element) => c.querySelector('[data-role="redo"]') as HTMLButtonElement;

describe('HistoryControls', () => {
  test('both buttons start disabled on a fresh store', () => {
    const store = createTestReadableStore<HistoryControlsSlice>({ canUndo: false, canRedo: false });
    const { container } = render(
      <HistoryControls store={store} onUndo={() => {}} onRedo={() => {}} undoTitle="Undo" redoTitle="Redo" />,
    );
    expect(undoBtn(container).disabled).toBe(true);
    expect(redoBtn(container).disabled).toBe(true);
  });

  test('canUndo/canRedo toggle the disabled state', () => {
    const store = createTestReadableStore<HistoryControlsSlice>({ canUndo: false, canRedo: false });
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
    const store = createTestReadableStore<HistoryControlsSlice>({ canUndo: true, canRedo: true });
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
    const store = createTestReadableStore<HistoryControlsSlice>({ canUndo: true, canRedo: true });
    const { container } = render(
      <HistoryControls store={store} onUndo={() => {}} onRedo={() => {}} undoTitle="Undo" redoTitle="Redo" />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
