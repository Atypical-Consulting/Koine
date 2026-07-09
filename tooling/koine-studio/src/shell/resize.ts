// Pointer-drag resizers for the IDE's panel grid. A panel is anchored to one edge of a container
// and its size is driven by a CSS custom property; dragging a handle sets that property (px) and
// persists it to localStorage. Pointer Events + setPointerCapture keep the drag alive outside the
// handle; a 'resizing' body class suppresses text selection for the duration.
//
// Three panels use this: the inspector (anchored right, drives --koi-inspector-w on #split), the
// file tree (anchored left, drives --koi-filetree-w on #split), and the diagnostics strip (anchored
// bottom, drives --koi-diag-h on #diagnostics).
import { readRaw, writeRaw } from '@/shell/storage';

/** The edge a panel is pinned to; size grows from the opposite side toward this edge. */
type Anchor = 'right' | 'left' | 'bottom' | 'top';

export interface EdgeResizerOptions {
  /** Element the size CSS var is written to (a grid container, or the panel itself). */
  target: HTMLElement;
  /** The draggable handle. */
  handle: HTMLElement;
  /** Element whose anchored edge is the fixed reference for computing size. Defaults to `target`. */
  container?: HTMLElement;
  /** CSS custom property set on `target`, e.g. '--koi-inspector-w'. */
  cssVar: string;
  /** Which edge the panel is pinned to. */
  anchor: Anchor;
  /** localStorage key for the persisted px size. */
  storageKey: string;
  /** Minimum size in px (default 160). */
  min?: number;
  /** Max size in px, or a function of the container's measured extent (default 70%). */
  max?: number | ((extent: number) => number);
}

/**
 * Wire pointer-drag resizing on `handle`, updating `cssVar` on `target` and persisting it.
 *
 * Returns a disposer that removes the listeners this call added. Callers that re-anchor a handle
 * after a layout toggle (the inspector / left-rail / group divider in ide.tsx) dispose the old
 * wiring and re-init with the new anchor/orientation, so the handle stays live without a reload.
 * The anchor/cssVar are captured at wire time, so re-init is the supported way to repoint them.
 */
export function initEdgeResizer(opts: EdgeResizerOptions): () => void {
  const { target, handle, cssVar, anchor, storageKey } = opts;
  const container = opts.container ?? target;
  const min = opts.min ?? 160;
  const horizontal = anchor === 'left' || anchor === 'right';

  const resolveMax = (extent: number): number => {
    if (typeof opts.max === 'number') return opts.max;
    if (typeof opts.max === 'function') return opts.max(extent);
    return extent * 0.7;
  };

  const clamp = (size: number, extent: number): number => {
    const max = resolveMax(extent);
    return Math.min(Math.max(size, min), Math.max(max, min));
  };

  const setSize = (px: number): void => {
    target.style.setProperty(cssVar, `${px}px`);
  };

  // Apply any persisted size on init (guarded against absent storage / bad value).
  const saved = readRaw(storageKey);
  if (saved) {
    const px = parseFloat(saved);
    const rect = container.getBoundingClientRect();
    if (Number.isFinite(px)) setSize(clamp(px, horizontal ? rect.width : rect.height));
  }

  let dragging = false;
  // Container geometry captured at pointerdown — invariant for the duration of one drag, so we
  // avoid a forced reflow (getBoundingClientRect) on every pointermove.
  let refEdge = 0;
  let extent = 0;

  const onPointerDown = (e: PointerEvent): void => {
    dragging = true;
    const rect = container.getBoundingClientRect();
    refEdge = rect[anchor];
    extent = horizontal ? rect.width : rect.height;
    handle.setPointerCapture(e.pointerId);
    document.body.classList.add('resizing', horizontal ? 'resizing-x' : 'resizing-y');
    e.preventDefault();
  };

  const onPointerMove = (e: PointerEvent): void => {
    if (!dragging) return;
    const pos = horizontal ? e.clientX : e.clientY;
    // Size = distance from the pointer to the anchored (fixed) edge.
    const size = anchor === 'right' || anchor === 'bottom' ? refEdge - pos : pos - refEdge;
    setSize(clamp(size, extent));
  };

  const end = (e: PointerEvent): void => {
    if (!dragging) return;
    dragging = false;
    if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId);
    document.body.classList.remove('resizing', 'resizing-x', 'resizing-y');
    // Persist the resolved size (read back the computed property to store the clamped px).
    const px = target.style.getPropertyValue(cssVar).trim();
    if (px) writeRaw(storageKey, px.replace('px', ''));
  };

  handle.addEventListener('pointerdown', onPointerDown);
  handle.addEventListener('pointermove', onPointerMove);
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);

  // Remove every listener this call added. Idempotent (a second call is a harmless no-op) and safe to
  // hold past the element's lifetime. Does NOT undo any size already written to the CSS var — only the
  // drag wiring is torn down, so the grid keeps its current size when the handle is re-anchored.
  return (): void => {
    handle.removeEventListener('pointerdown', onPointerDown);
    handle.removeEventListener('pointermove', onPointerMove);
    handle.removeEventListener('pointerup', end);
    handle.removeEventListener('pointercancel', end);
  };
}

export interface SplitResizerOptions {
  split: HTMLElement;
  handle: HTMLElement;
  storageKey?: string;
  min?: number;
  max?: number;
}

/**
 * Wire pointer-drag resizing for the editor/inspector split: the inspector is anchored to the
 * right edge of `split` and its width is driven by `--koi-inspector-w`. Thin wrapper over
 * {@link initEdgeResizer} kept for the existing call site. Returns its disposer.
 */
export function initSplitResizer(opts: SplitResizerOptions): () => void {
  return initEdgeResizer({
    target: opts.split,
    handle: opts.handle,
    cssVar: '--koi-inspector-w',
    anchor: 'right',
    storageKey: opts.storageKey ?? 'koine.studio.splitWidth',
    min: opts.min ?? 220,
    max: opts.max,
  });
}
