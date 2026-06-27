// CenterSplitter — a keyboard- and pointer-accessible resize handle between two adjacent center panes.
//
// Mounted by applySplitPaneLayout between every pair of adjacent .center-split-pane slots. Its role,
// ARIA attributes, and keyboard handler satisfy WCAG 2.1 AA (SC 2.1.1 / SC 4.1.2) for resize widgets.
import { useRef } from 'preact/hooks';
import type { CenterLayout } from '@/store/slices/uiChrome';

const MIN_PANE_FRACTION = 0.15; // 15% minimum per pane
const KEYBOARD_STEP = 0.02; // 2% per arrow-key press

export interface CenterSplitterProps {
  layout: CenterLayout;
  splitterIndex: number; // index of the "before" pane (0 means between pane[0] and pane[1])
  containerEl: HTMLElement; // #center-body — used for pointer-drag geometry
  onResize(sizes: number[]): void; // calls appStore.getState().resizeCenter(sizes)
}

/** Clamp each fraction to MIN_PANE_FRACTION and renormalise so they always sum to 1. */
function clampSizes(newSizes: number[]): number[] {
  const clamped = newSizes.map((s) => Math.max(MIN_PANE_FRACTION, s));
  const total = clamped.reduce((a, b) => a + b, 0);
  return clamped.map((s) => s / total);
}

export function CenterSplitter({ layout, splitterIndex, containerEl, onResize }: CenterSplitterProps) {
  const { orientation, sizes } = layout;
  const isDragging = useRef(false);

  // Express as integer percentage for aria-valuenow (0-100 scale).
  const currentVal = Math.round(sizes[splitterIndex] * 100);

  function nudge(delta: number): void {
    const newSizes = [...sizes];
    newSizes[splitterIndex] = (newSizes[splitterIndex] ?? 0) + delta;
    newSizes[splitterIndex + 1] = (newSizes[splitterIndex + 1] ?? 0) - delta;
    onResize(clampSizes(newSizes));
  }

  function onKeyDown(e: KeyboardEvent): void {
    const isRow = orientation === 'row';
    if (isRow && e.key === 'ArrowLeft') {
      e.preventDefault();
      nudge(-KEYBOARD_STEP);
    } else if (isRow && e.key === 'ArrowRight') {
      e.preventDefault();
      nudge(KEYBOARD_STEP);
    } else if (!isRow && e.key === 'ArrowUp') {
      e.preventDefault();
      nudge(-KEYBOARD_STEP);
    } else if (!isRow && e.key === 'ArrowDown') {
      e.preventDefault();
      nudge(KEYBOARD_STEP);
    }
  }

  function onPointerDown(e: PointerEvent): void {
    e.preventDefault();
    isDragging.current = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: PointerEvent): void {
    if (!isDragging.current) return;
    const rect = containerEl.getBoundingClientRect();
    const isRow = orientation === 'row';

    // cursor fraction relative to container
    const ratio = isRow ? (e.clientX - rect.left) / rect.width : (e.clientY - rect.top) / rect.height;

    // The splitter sits between pane[splitterIndex] and pane[splitterIndex+1].
    // All panes before index splitterIndex contribute `preSize` to the left/top.
    const preSize = sizes.slice(0, splitterIndex).reduce((a, b) => a + b, 0);
    const pane0New = ratio - preSize;
    const restAfterPre = 1 - preSize;
    const pane1New = restAfterPre - pane0New;

    const newSizes = [...sizes];
    newSizes[splitterIndex] = pane0New;
    newSizes[splitterIndex + 1] = pane1New;
    onResize(clampSizes(newSizes));
  }

  function onPointerUp(e: PointerEvent): void {
    if (!isDragging.current) return;
    isDragging.current = false;
    // Release pointer capture so future events are dispatched normally, and so a cancelled
    // pointer (Alt+Tab, OS interrupt) doesn't leave isDragging stuck true (Bug 4 fix).
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
  }

  return (
    <div
      role="separator"
      aria-orientation={orientation === 'row' ? 'vertical' : 'horizontal'}
      aria-valuenow={currentVal}
      aria-valuemin={Math.round(MIN_PANE_FRACTION * 100)}
      aria-valuemax={Math.round((1 - MIN_PANE_FRACTION) * 100)}
      aria-label="Resize panes"
      tabIndex={0}
      class={`center-splitter center-splitter--${orientation}`}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    />
  );
}
