// Pointer-drag resizers for the IDE's panel grid. A panel is anchored to one edge of a container
// and its size is driven by a CSS custom property; dragging a handle sets that property (px) and
// persists it to localStorage. Pointer Events + setPointerCapture keep the drag alive outside the
// handle; a 'resizing' body class suppresses text selection for the duration.
//
// Three panels use this: the inspector (anchored right, drives --koi-inspector-w on #split), the
// file tree (anchored left, drives --koi-filetree-w on #split), and the diagnostics strip (anchored
// bottom, drives --koi-diag-h on #diagnostics).

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

/** Wire pointer-drag resizing on `handle`, updating `cssVar` on `target` and persisting it. */
export function initEdgeResizer(opts: EdgeResizerOptions): void {
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
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved) {
      const px = parseFloat(saved);
      const rect = container.getBoundingClientRect();
      if (Number.isFinite(px)) setSize(clamp(px, horizontal ? rect.width : rect.height));
    }
  } catch {
    // ignore — no persistence available
  }

  let dragging = false;
  // Container geometry captured at pointerdown — invariant for the duration of one drag, so we
  // avoid a forced reflow (getBoundingClientRect) on every pointermove.
  let refEdge = 0;
  let extent = 0;

  handle.addEventListener('pointerdown', (e: PointerEvent) => {
    dragging = true;
    const rect = container.getBoundingClientRect();
    refEdge = rect[anchor];
    extent = horizontal ? rect.width : rect.height;
    handle.setPointerCapture(e.pointerId);
    document.body.classList.add('resizing', horizontal ? 'resizing-x' : 'resizing-y');
    e.preventDefault();
  });

  handle.addEventListener('pointermove', (e: PointerEvent) => {
    if (!dragging) return;
    const pos = horizontal ? e.clientX : e.clientY;
    // Size = distance from the pointer to the anchored (fixed) edge.
    const size = anchor === 'right' || anchor === 'bottom' ? refEdge - pos : pos - refEdge;
    setSize(clamp(size, extent));
  });

  const end = (e: PointerEvent): void => {
    if (!dragging) return;
    dragging = false;
    if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId);
    document.body.classList.remove('resizing', 'resizing-x', 'resizing-y');
    // Persist the resolved size (read back the computed property to store the clamped px).
    try {
      const px = target.style.getPropertyValue(cssVar).trim();
      if (px) localStorage.setItem(storageKey, px.replace('px', ''));
    } catch {
      // ignore — no persistence available
    }
  };

  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
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
 * {@link initEdgeResizer} kept for the existing call site.
 */
export function initSplitResizer(opts: SplitResizerOptions): void {
  initEdgeResizer({
    target: opts.split,
    handle: opts.handle,
    cssVar: '--koi-inspector-w',
    anchor: 'right',
    storageKey: opts.storageKey ?? 'koine.studio.splitWidth',
    min: opts.min ?? 220,
    max: opts.max,
  });
}

export interface GroupResizerOptions {
  /** The split container element; the size CSS var is written to this element. */
  split: HTMLElement;
  /** The draggable divider handle. */
  handle: HTMLElement;
  /**
   * `'horizontal'` — side-by-side split with a vertical divider (anchored right, drives
   * `--koi-group-w`). `'vertical'` — stacked split with a horizontal divider (anchored bottom,
   * drives `--koi-group-h`).
   */
  orientation: 'horizontal' | 'vertical';
  /** localStorage key for the persisted px size. Defaults to `'koine.studio.groupSize'`. */
  storageKey?: string;
}

/**
 * Wire pointer-drag resizing for an editor-group divider. Maps `orientation` to the appropriate
 * anchor and CSS custom property, then delegates to {@link initEdgeResizer}.
 */
export function initGroupResizer(opts: GroupResizerOptions): void {
  const horizontal = opts.orientation === 'horizontal';
  initEdgeResizer({
    target: opts.split,
    handle: opts.handle,
    cssVar: horizontal ? '--koi-group-w' : '--koi-group-h',
    anchor: horizontal ? 'right' : 'bottom',
    storageKey: opts.storageKey ?? 'koine.studio.groupSize',
  });
}
