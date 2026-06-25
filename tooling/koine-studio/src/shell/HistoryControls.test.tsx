import { describe, expect, test, vi } from 'vitest';
import { act, fireEvent, render } from '@testing-library/preact';
import { createAppStore } from '@/store/index';
import { HistoryControls } from '@/shell/HistoryControls';
import { axe } from 'vitest-axe';

const undoBtn = (c: Element) => c.querySelector('[data-role="undo"]') as HTMLButtonElement;
const redoBtn = (c: Element) => c.querySelector('[data-role="redo"]') as HTMLButtonElement;

describe('HistoryControls', () => {
  test('both buttons start disabled on a fresh store', () => {
    const store = createAppStore();
    const { container } = render(
      <HistoryControls store={store} onUndo={() => {}} onRedo={() => {}} undoTitle="Undo" redoTitle="Redo" />,
    );
    expect(undoBtn(container).disabled).toBe(true);
    expect(redoBtn(container).disabled).toBe(true);
  });

  test('canUndo/canRedo toggle the disabled state', () => {
    const store = createAppStore();
    const { container } = render(
      <HistoryControls store={store} onUndo={() => {}} onRedo={() => {}} undoTitle="Undo" redoTitle="Redo" />,
    );
    act(() => store.getState().setHistoryState({ canUndo: true, canRedo: false }));
    expect(undoBtn(container).disabled).toBe(false);
    expect(redoBtn(container).disabled).toBe(true);
    act(() => store.getState().setHistoryState({ canUndo: false, canRedo: true }));
    expect(undoBtn(container).disabled).toBe(true);
    expect(redoBtn(container).disabled).toBe(false);
  });

  test('clicks call the handlers', () => {
    const store = createAppStore();
    const onUndo = vi.fn();
    const onRedo = vi.fn();
    act(() => store.getState().setHistoryState({ canUndo: true, canRedo: true }));
    const { container } = render(
      <HistoryControls store={store} onUndo={onUndo} onRedo={onRedo} undoTitle="Undo" redoTitle="Redo" />,
    );
    fireEvent.click(undoBtn(container));
    fireEvent.click(redoBtn(container));
    expect(onUndo).toHaveBeenCalledOnce();
    expect(onRedo).toHaveBeenCalledOnce();
  });

  test('has no accessibility violations', async () => {
    const store = createAppStore();
    act(() => store.getState().setHistoryState({ canUndo: true, canRedo: true }));
    const { container } = render(
      <HistoryControls store={store} onUndo={() => {}} onRedo={() => {}} undoTitle="Undo" redoTitle="Redo" />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
