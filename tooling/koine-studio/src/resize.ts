// Draggable split resizer for the editor/inspector grid. The #split grid is laid out as
// 'grid-template-columns: auto 1fr 6px var(--koi-inspector-w, 1fr)'; the 6px track is the
// .koi-resizer handle. Dragging sets --koi-inspector-w on #split (px) and persists it to
// localStorage. Pointer Events + setPointerCapture keep the drag alive outside the handle;
// a 'resizing' body class suppresses text selection for the duration.

const DEFAULT_KEY = 'koine.studio.splitWidth';
const DEFAULT_MIN = 220;

export interface SplitResizerOptions {
  split: HTMLElement;
  handle: HTMLElement;
  storageKey?: string;
  min?: number;
  max?: number;
}

/** Wire pointer-drag resizing on `handle`, updating `--koi-inspector-w` on `split`. */
export function initSplitResizer(opts: SplitResizerOptions): void {
  const { split, handle } = opts;
  const storageKey = opts.storageKey ?? DEFAULT_KEY;
  const min = opts.min ?? DEFAULT_MIN;

  // Clamp a desired inspector width to [min, max], where max defaults to 70% of the
  // split's current width (recomputed per drag so window resizes stay honoured).
  const clamp = (width: number): number => {
    const max = opts.max ?? split.getBoundingClientRect().width * 0.7;
    return Math.min(Math.max(width, min), Math.max(max, min));
  };

  const setWidth = (px: number): void => {
    split.style.setProperty('--koi-inspector-w', `${px}px`);
  };

  // Apply any persisted width on init (guarded against absent storage / bad value).
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved) {
      const px = parseFloat(saved);
      if (Number.isFinite(px)) setWidth(clamp(px));
    }
  } catch {
    // ignore — no persistence available
  }

  let dragging = false;

  handle.addEventListener('pointerdown', (e: PointerEvent) => {
    dragging = true;
    handle.setPointerCapture(e.pointerId);
    document.body.classList.add('resizing');
    e.preventDefault();
  });

  handle.addEventListener('pointermove', (e: PointerEvent) => {
    if (!dragging) return;
    // Inspector width = distance from the pointer to the split's right edge.
    const right = split.getBoundingClientRect().right;
    setWidth(clamp(right - e.clientX));
  });

  const end = (e: PointerEvent): void => {
    if (!dragging) return;
    dragging = false;
    if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId);
    document.body.classList.remove('resizing');
    // Persist the resolved width (read back the computed property to store the clamped px).
    try {
      const px = split.style.getPropertyValue('--koi-inspector-w').trim();
      if (px) localStorage.setItem(storageKey, px.replace('px', ''));
    } catch {
      // ignore — no persistence available
    }
  };

  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}
