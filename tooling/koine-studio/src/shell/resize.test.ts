// Unit tests for the pointer-drag edge resizers (resize.ts). These exercise the resize math
// (size derived from pointer position vs. the anchored edge), the min/max clamping at both bounds,
// the full pointerdown → pointermove → pointerup drag lifecycle (real PointerEvents on elements
// mounted in document.body), the `resizing` body-class toggling, and the localStorage persistence
// (both restore-on-init and save-on-drag-end). happy-dom supplies PointerEvent, setPointerCapture,
// and getBoundingClientRect; test-setup.ts installs the in-memory localStorage shim.
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { initEdgeResizer, initGroupResizer, initSplitResizer, type EdgeResizerOptions } from '@/shell/resize';

// ---------------------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------------------

/** A fixed container rect so the size math is deterministic (no real layout under happy-dom). */
function stubRect(el: HTMLElement, rect: Partial<DOMRect>): void {
  const full: DOMRect = {
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
    width: 0,
    height: 0,
    x: 0,
    y: 0,
    toJSON: () => ({}),
    ...rect,
  } as DOMRect;
  el.getBoundingClientRect = () => full;
}

/** Mount a target + handle in the body and return them (and the body class list for assertions). */
function mount(): { target: HTMLElement; handle: HTMLElement; container: HTMLElement } {
  const container = document.createElement('div');
  const target = document.createElement('div');
  const handle = document.createElement('div');
  container.appendChild(target);
  container.appendChild(handle);
  document.body.appendChild(container);
  return { target, handle, container };
}

/** Read the px value of the CSS var the resizer writes to `target`, as a number. */
function sizeOf(target: HTMLElement, cssVar: string): number {
  return parseFloat(target.style.getPropertyValue(cssVar).replace('px', ''));
}

function pointerdown(el: HTMLElement, clientX: number, clientY: number, pointerId = 1): void {
  el.dispatchEvent(
    new PointerEvent('pointerdown', { clientX, clientY, pointerId, bubbles: true, cancelable: true }),
  );
}
function pointermove(el: HTMLElement, clientX: number, clientY: number, pointerId = 1): void {
  el.dispatchEvent(new PointerEvent('pointermove', { clientX, clientY, pointerId, bubbles: true }));
}
function pointerup(el: HTMLElement, clientX: number, clientY: number, pointerId = 1): void {
  el.dispatchEvent(new PointerEvent('pointerup', { clientX, clientY, pointerId, bubbles: true }));
}

const CSS_VAR = '--koi-inspector-w';

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  document.body.innerHTML = '';
  document.body.classList.remove('resizing', 'resizing-x', 'resizing-y');
  localStorage.clear();
});

// ---------------------------------------------------------------------------
// Resize math per anchor (the size = pointer-vs-anchored-edge formula)
// ---------------------------------------------------------------------------

describe('initEdgeResizer — resize math by anchor', () => {
  test("anchor 'right': dragging left of the right edge yields (right − clientX)", () => {
    const { target, handle, container } = mount();
    // Container right edge at x=800, width 800. min low so the result is not clamped.
    stubRect(container, { left: 0, right: 800, width: 800 });
    initEdgeResizer({
      target,
      handle,
      container,
      cssVar: CSS_VAR,
      anchor: 'right',
      storageKey: 'k',
      min: 10,
      max: 1000,
    });

    pointerdown(handle, 800, 0);
    pointermove(handle, 500, 0); // 300px in from the right edge
    expect(sizeOf(target, CSS_VAR)).toBe(300);
  });

  test("anchor 'left': dragging right of the left edge yields (clientX − left)", () => {
    const { target, handle, container } = mount();
    stubRect(container, { left: 100, right: 900, width: 800 });
    initEdgeResizer({
      target,
      handle,
      container,
      cssVar: CSS_VAR,
      anchor: 'left',
      storageKey: 'k',
      min: 10,
      max: 1000,
    });

    pointerdown(handle, 100, 0);
    pointermove(handle, 350, 0); // 250px in from the left edge (350 − 100)
    expect(sizeOf(target, CSS_VAR)).toBe(250);
  });

  test("anchor 'bottom': vertical drag yields (bottom − clientY)", () => {
    const { target, handle, container } = mount();
    stubRect(container, { top: 0, bottom: 600, height: 600 });
    initEdgeResizer({
      target,
      handle,
      container,
      cssVar: '--koi-diag-h',
      anchor: 'bottom',
      storageKey: 'k',
      min: 10,
      max: 1000,
    });

    pointerdown(handle, 0, 600);
    pointermove(handle, 0, 400); // 200px up from the bottom edge
    expect(sizeOf(target, '--koi-diag-h')).toBe(200);
  });

  test("anchor 'top': vertical drag yields (clientY − top)", () => {
    const { target, handle, container } = mount();
    stubRect(container, { top: 50, bottom: 650, height: 600 });
    initEdgeResizer({
      target,
      handle,
      container,
      cssVar: '--koi-diag-h',
      anchor: 'top',
      storageKey: 'k',
      min: 10,
      max: 1000,
    });

    pointerdown(handle, 0, 50);
    pointermove(handle, 0, 230); // 180px down from the top edge (230 − 50)
    expect(sizeOf(target, '--koi-diag-h')).toBe(180);
  });
});

// ---------------------------------------------------------------------------
// Clamping at both bounds and in the normal range
// ---------------------------------------------------------------------------

describe('initEdgeResizer — clamping', () => {
  function setup(extra: Partial<EdgeResizerOptions> = {}): {
    target: HTMLElement;
    handle: HTMLElement;
  } {
    const { target, handle, container } = mount();
    stubRect(container, { left: 0, right: 800, width: 800 });
    initEdgeResizer({
      target,
      handle,
      container,
      cssVar: CSS_VAR,
      anchor: 'right',
      storageKey: 'k',
      min: 160,
      max: 500,
      ...extra,
    });
    return { target, handle };
  }

  test('clamps to min when the pointer overshoots toward the anchored edge', () => {
    const { target, handle } = setup();
    pointerdown(handle, 800, 0);
    // Pointer near the right edge → raw size 50px, below the 160 floor.
    pointermove(handle, 750, 0);
    expect(sizeOf(target, CSS_VAR)).toBe(160);
  });

  test('clamps to max when the pointer overshoots away from the anchored edge', () => {
    const { target, handle } = setup();
    pointerdown(handle, 800, 0);
    // Pointer far from the right edge → raw size 700px, above the 500 ceiling.
    pointermove(handle, 100, 0);
    expect(sizeOf(target, CSS_VAR)).toBe(500);
  });

  test('passes through unchanged inside the [min, max] range', () => {
    const { target, handle } = setup();
    pointerdown(handle, 800, 0);
    pointermove(handle, 500, 0); // raw 300px, within [160, 500]
    expect(sizeOf(target, CSS_VAR)).toBe(300);
  });

  test('a numeric max exactly bounds the upper edge', () => {
    const { target, handle } = setup({ max: 400 });
    pointerdown(handle, 800, 0);
    pointermove(handle, 350, 0); // raw 450px → clamped to 400
    expect(sizeOf(target, CSS_VAR)).toBe(400);
  });

  test('a max BELOW min collapses to min (max floored to min)', () => {
    // clamp uses Math.max(max, min) for the ceiling, so a max < min pins the size at min.
    const { target, handle } = setup({ min: 200, max: 100 });
    pointerdown(handle, 800, 0);
    pointermove(handle, 600, 0); // raw 200px, but ceiling = max(100,200) = 200, floor = 200
    expect(sizeOf(target, CSS_VAR)).toBe(200);
  });
});

describe('initEdgeResizer — max as a function / default', () => {
  test('a function max is evaluated against the measured container extent', () => {
    const { target, handle, container } = mount();
    stubRect(container, { left: 0, right: 1000, width: 1000 });
    initEdgeResizer({
      target,
      handle,
      container,
      cssVar: CSS_VAR,
      anchor: 'right',
      storageKey: 'k',
      min: 100,
      // Half of the container's width → 500px ceiling.
      max: (extent) => extent / 2,
    });

    pointerdown(handle, 1000, 0);
    pointermove(handle, 100, 0); // raw 900px → clamped to extent/2 = 500
    expect(sizeOf(target, CSS_VAR)).toBe(500);
  });

  test('the default max is 70% of the container extent when no max is supplied', () => {
    const { target, handle, container } = mount();
    stubRect(container, { left: 0, right: 1000, width: 1000 });
    initEdgeResizer({
      target,
      handle,
      container,
      cssVar: CSS_VAR,
      anchor: 'right',
      storageKey: 'k',
      min: 50,
      // no max → defaults to extent * 0.7 = 700px
    });

    pointerdown(handle, 1000, 0);
    pointermove(handle, 0, 0); // raw 1000px → clamped to 700
    expect(sizeOf(target, CSS_VAR)).toBe(700);
  });

  test('the default min is 160 when no min is supplied', () => {
    const { target, handle, container } = mount();
    stubRect(container, { left: 0, right: 1000, width: 1000 });
    initEdgeResizer({
      target,
      handle,
      container,
      cssVar: CSS_VAR,
      anchor: 'right',
      storageKey: 'k',
      max: 1000,
      // no min → defaults to 160
    });

    pointerdown(handle, 1000, 0);
    pointermove(handle, 990, 0); // raw 10px → clamped up to the default 160 floor
    expect(sizeOf(target, CSS_VAR)).toBe(160);
  });
});

// ---------------------------------------------------------------------------
// container defaults to target
// ---------------------------------------------------------------------------

describe('initEdgeResizer — container defaults to target', () => {
  test('uses the target element for geometry when no container is given', () => {
    const { target, handle } = mount();
    // No `container` option: geometry must be read off `target` itself.
    stubRect(target, { left: 0, right: 600, width: 600 });
    initEdgeResizer({
      target,
      handle,
      cssVar: CSS_VAR,
      anchor: 'right',
      storageKey: 'k',
      min: 10,
      max: 1000,
    });

    pointerdown(handle, 600, 0);
    pointermove(handle, 400, 0); // 200px in from target's right edge
    expect(sizeOf(target, CSS_VAR)).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Drag lifecycle: dragging gate, body classes, capture
// ---------------------------------------------------------------------------

describe('initEdgeResizer — drag lifecycle', () => {
  function setup(): { target: HTMLElement; handle: HTMLElement } {
    const { target, handle, container } = mount();
    stubRect(container, { left: 0, right: 800, width: 800 });
    initEdgeResizer({
      target,
      handle,
      container,
      cssVar: CSS_VAR,
      anchor: 'right',
      storageKey: 'k',
      min: 10,
      max: 1000,
    });
    return { target, handle };
  }

  test('a pointermove before any pointerdown is a no-op (dragging gate)', () => {
    const { target, handle } = setup();
    pointermove(handle, 500, 0);
    // Nothing was written because the drag never started.
    expect(target.style.getPropertyValue(CSS_VAR)).toBe('');
  });

  test('adds resizing / resizing-x classes on pointerdown (horizontal anchor)', () => {
    const { handle } = setup();
    pointerdown(handle, 800, 0);
    expect(document.body.classList.contains('resizing')).toBe(true);
    expect(document.body.classList.contains('resizing-x')).toBe(true);
    expect(document.body.classList.contains('resizing-y')).toBe(false);
  });

  test('adds resizing-y for a vertical anchor', () => {
    const { target, handle, container } = mount();
    stubRect(container, { top: 0, bottom: 600, height: 600 });
    initEdgeResizer({
      target,
      handle,
      container,
      cssVar: '--koi-diag-h',
      anchor: 'bottom',
      storageKey: 'k',
      min: 10,
      max: 1000,
    });
    pointerdown(handle, 0, 600);
    expect(document.body.classList.contains('resizing-y')).toBe(true);
    expect(document.body.classList.contains('resizing-x')).toBe(false);
  });

  test('removes the resizing classes on pointerup', () => {
    const { handle } = setup();
    pointerdown(handle, 800, 0);
    pointermove(handle, 500, 0);
    pointerup(handle, 500, 0);
    expect(document.body.classList.contains('resizing')).toBe(false);
    expect(document.body.classList.contains('resizing-x')).toBe(false);
    expect(document.body.classList.contains('resizing-y')).toBe(false);
  });

  test('a pointermove after pointerup no longer resizes (drag ended)', () => {
    const { target, handle } = setup();
    pointerdown(handle, 800, 0);
    pointermove(handle, 500, 0);
    expect(sizeOf(target, CSS_VAR)).toBe(300);
    pointerup(handle, 500, 0);
    // Further moves are ignored — the value stays at the last committed size.
    pointermove(handle, 200, 0);
    expect(sizeOf(target, CSS_VAR)).toBe(300);
  });

  test('pointercancel also ends the drag', () => {
    const { target, handle } = setup();
    pointerdown(handle, 800, 0);
    pointermove(handle, 500, 0);
    handle.dispatchEvent(new PointerEvent('pointercancel', { clientX: 500, clientY: 0, pointerId: 1 }));
    expect(document.body.classList.contains('resizing')).toBe(false);
    // After cancel, moves are ignored.
    pointermove(handle, 200, 0);
    expect(sizeOf(target, CSS_VAR)).toBe(300);
  });

  test('a stray pointerup with no active drag is a no-op (early return in end)', () => {
    const { handle } = setup();
    // No pointerdown first; end() must early-return without touching body classes.
    document.body.classList.add('resizing'); // sentinel that end() must NOT clear when idle
    pointerup(handle, 500, 0);
    expect(document.body.classList.contains('resizing')).toBe(true);
  });

  test('ends cleanly when the handle no longer holds pointer capture (release skipped)', () => {
    const { target, handle } = setup();
    pointerdown(handle, 800, 0);
    pointermove(handle, 500, 0);
    // Simulate capture already lost (e.g. the browser implicitly released it): hasPointerCapture
    // returns false, so end() must skip releasePointerCapture but still finish the drag.
    handle.hasPointerCapture = () => false;
    pointerup(handle, 500, 0);
    expect(document.body.classList.contains('resizing')).toBe(false);
    expect(sizeOf(target, CSS_VAR)).toBe(300);
  });

  test('a sequence of moves tracks the pointer continuously', () => {
    const { target, handle } = setup();
    pointerdown(handle, 800, 0);
    pointermove(handle, 700, 0);
    expect(sizeOf(target, CSS_VAR)).toBe(100);
    pointermove(handle, 600, 0);
    expect(sizeOf(target, CSS_VAR)).toBe(200);
    pointermove(handle, 550, 0);
    expect(sizeOf(target, CSS_VAR)).toBe(250);
  });
});

// ---------------------------------------------------------------------------
// Persistence: save on drag end, restore on init
// ---------------------------------------------------------------------------

describe('initEdgeResizer — persistence', () => {
  test('persists the clamped px (number only, no unit) to localStorage on pointerup', () => {
    const { target, handle, container } = mount();
    stubRect(container, { left: 0, right: 800, width: 800 });
    initEdgeResizer({
      target,
      handle,
      container,
      cssVar: CSS_VAR,
      anchor: 'right',
      storageKey: 'koine.test.width',
      min: 160,
      max: 500,
    });

    pointerdown(handle, 800, 0);
    pointermove(handle, 100, 0); // raw 700px → clamped to 500
    pointerup(handle, 100, 0);
    // The stored value is the clamped size, stripped of the 'px' suffix.
    expect(localStorage.getItem('koine.test.width')).toBe('500');
  });

  test('persists the in-range size verbatim', () => {
    const { target, handle, container } = mount();
    stubRect(container, { left: 0, right: 800, width: 800 });
    initEdgeResizer({
      target,
      handle,
      container,
      cssVar: CSS_VAR,
      anchor: 'right',
      storageKey: 'koine.test.width',
      min: 10,
      max: 1000,
    });

    pointerdown(handle, 800, 0);
    pointermove(handle, 500, 0); // 300px
    pointerup(handle, 500, 0);
    expect(localStorage.getItem('koine.test.width')).toBe('300');
  });

  test('a drag that never moved persists nothing (CSS var never set)', () => {
    const { handle, container } = mount();
    stubRect(container, { left: 0, right: 800, width: 800 });
    initEdgeResizer({
      target: container, // reuse the container as target so it has no CSS var yet
      handle,
      container,
      cssVar: CSS_VAR,
      anchor: 'right',
      storageKey: 'koine.test.width',
      min: 10,
      max: 1000,
    });

    pointerdown(handle, 800, 0);
    pointerup(handle, 800, 0); // no move ⇒ no CSS var ⇒ nothing written
    expect(localStorage.getItem('koine.test.width')).toBeNull();
  });

  test('restores a persisted size on init, clamped to the current container extent', () => {
    const { target, handle, container } = mount();
    stubRect(container, { left: 0, right: 800, width: 800 });
    localStorage.setItem('koine.test.width', '350');
    initEdgeResizer({
      target,
      handle,
      container,
      cssVar: CSS_VAR,
      anchor: 'right',
      storageKey: 'koine.test.width',
      min: 160,
      max: 500,
    });
    // 350 is within [160, 500] → applied as-is.
    expect(sizeOf(target, CSS_VAR)).toBe(350);
  });

  test('a restored size above the current max is clamped down on init', () => {
    const { target, handle, container } = mount();
    stubRect(container, { left: 0, right: 800, width: 800 });
    localStorage.setItem('koine.test.width', '999'); // above max
    initEdgeResizer({
      target,
      handle,
      container,
      cssVar: CSS_VAR,
      anchor: 'right',
      storageKey: 'koine.test.width',
      min: 160,
      max: 500,
    });
    expect(sizeOf(target, CSS_VAR)).toBe(500);
  });

  test('a restored size below the current min is clamped up on init', () => {
    const { target, handle, container } = mount();
    stubRect(container, { left: 0, right: 800, width: 800 });
    localStorage.setItem('koine.test.width', '10'); // below min
    initEdgeResizer({
      target,
      handle,
      container,
      cssVar: CSS_VAR,
      anchor: 'right',
      storageKey: 'koine.test.width',
      min: 160,
      max: 500,
    });
    expect(sizeOf(target, CSS_VAR)).toBe(160);
  });

  test('a non-finite persisted value is ignored on init (CSS var stays unset)', () => {
    const { target, handle, container } = mount();
    stubRect(container, { left: 0, right: 800, width: 800 });
    localStorage.setItem('koine.test.width', 'not-a-number');
    initEdgeResizer({
      target,
      handle,
      container,
      cssVar: CSS_VAR,
      anchor: 'right',
      storageKey: 'koine.test.width',
      min: 160,
      max: 500,
    });
    // parseFloat('not-a-number') is NaN → guarded by Number.isFinite → nothing applied.
    expect(target.style.getPropertyValue(CSS_VAR)).toBe('');
  });

  test('no persisted value means no size is applied on init', () => {
    const { target, handle, container } = mount();
    stubRect(container, { left: 0, right: 800, width: 800 });
    initEdgeResizer({
      target,
      handle,
      container,
      cssVar: CSS_VAR,
      anchor: 'right',
      storageKey: 'koine.absent.key',
      min: 160,
      max: 500,
    });
    expect(target.style.getPropertyValue(CSS_VAR)).toBe('');
  });

  test('a vertical anchor restores against the container HEIGHT extent', () => {
    const { target, handle, container } = mount();
    stubRect(container, { top: 0, bottom: 600, height: 600 });
    // max function of extent: 50% of height = 300; saved 400 must clamp down to 300.
    localStorage.setItem('koine.diag.h', '400');
    initEdgeResizer({
      target,
      handle,
      container,
      cssVar: '--koi-diag-h',
      anchor: 'bottom',
      storageKey: 'koine.diag.h',
      min: 10,
      max: (extent) => extent / 2,
    });
    expect(sizeOf(target, '--koi-diag-h')).toBe(300);
  });

  test('a full drag round-trips: the saved value restores into a fresh resizer', () => {
    // First resizer: drag to 300px and release.
    const first = mount();
    stubRect(first.container, { left: 0, right: 800, width: 800 });
    initEdgeResizer({
      target: first.target,
      handle: first.handle,
      container: first.container,
      cssVar: CSS_VAR,
      anchor: 'right',
      storageKey: 'koine.roundtrip',
      min: 10,
      max: 1000,
    });
    pointerdown(first.handle, 800, 0);
    pointermove(first.handle, 500, 0);
    pointerup(first.handle, 500, 0);
    expect(localStorage.getItem('koine.roundtrip')).toBe('300');

    // Second resizer (a fresh mount) reads the saved value back on init.
    const second = mount();
    stubRect(second.container, { left: 0, right: 800, width: 800 });
    initEdgeResizer({
      target: second.target,
      handle: second.handle,
      container: second.container,
      cssVar: CSS_VAR,
      anchor: 'right',
      storageKey: 'koine.roundtrip',
      min: 10,
      max: 1000,
    });
    expect(sizeOf(second.target, CSS_VAR)).toBe(300);
  });
});

// ---------------------------------------------------------------------------
// initSplitResizer — the thin wrapper for the editor/inspector split
// ---------------------------------------------------------------------------

describe('initSplitResizer', () => {
  test('drives --koi-inspector-w anchored to the right of split and persists under the default key', () => {
    const split = document.createElement('div');
    const handle = document.createElement('div');
    document.body.appendChild(split);
    document.body.appendChild(handle);
    stubRect(split, { left: 0, right: 1000, width: 1000 });

    initSplitResizer({ split, handle });

    pointerdown(handle, 1000, 0);
    pointermove(handle, 600, 0); // 400px in from the right edge (within the 220 min / 70% default max)
    expect(sizeOf(split, '--koi-inspector-w')).toBe(400);

    pointerup(handle, 600, 0);
    // Default storageKey is 'koine.studio.splitWidth'.
    expect(localStorage.getItem('koine.studio.splitWidth')).toBe('400');
  });

  test('applies the default 220px minimum', () => {
    const split = document.createElement('div');
    const handle = document.createElement('div');
    document.body.appendChild(split);
    document.body.appendChild(handle);
    stubRect(split, { left: 0, right: 1000, width: 1000 });

    initSplitResizer({ split, handle });

    pointerdown(handle, 1000, 0);
    pointermove(handle, 950, 0); // raw 50px → clamped up to the 220 default floor
    expect(sizeOf(split, '--koi-inspector-w')).toBe(220);
  });

  test('honours an explicit storageKey, min and max override', () => {
    const split = document.createElement('div');
    const handle = document.createElement('div');
    document.body.appendChild(split);
    document.body.appendChild(handle);
    stubRect(split, { left: 0, right: 1000, width: 1000 });

    initSplitResizer({ split, handle, storageKey: 'custom.key', min: 100, max: 350 });

    pointerdown(handle, 1000, 0);
    pointermove(handle, 500, 0); // raw 500px → clamped to the 350 ceiling
    expect(sizeOf(split, '--koi-inspector-w')).toBe(350);
    pointerup(handle, 500, 0);
    expect(localStorage.getItem('custom.key')).toBe('350');
  });

  test('restores a persisted split width under the default key on init', () => {
    const split = document.createElement('div');
    const handle = document.createElement('div');
    document.body.appendChild(split);
    document.body.appendChild(handle);
    stubRect(split, { left: 0, right: 1000, width: 1000 });
    localStorage.setItem('koine.studio.splitWidth', '450');

    initSplitResizer({ split, handle });
    expect(sizeOf(split, '--koi-inspector-w')).toBe(450);
  });
});

// ---------------------------------------------------------------------------
// initGroupResizer — the thin wrapper for the editor-group divider
// ---------------------------------------------------------------------------

describe('initGroupResizer — horizontal orientation (side-by-side, vertical divider)', () => {
  test('drives --koi-group-w anchored to the right of split and persists under the default key', () => {
    const split = document.createElement('div');
    const handle = document.createElement('div');
    document.body.appendChild(split);
    document.body.appendChild(handle);
    stubRect(split, { left: 0, right: 1000, width: 1000 });

    initGroupResizer({ split, handle, orientation: 'horizontal' });

    pointerdown(handle, 1000, 0);
    pointermove(handle, 600, 0); // 400px in from the right edge
    expect(sizeOf(split, '--koi-group-w')).toBe(400);

    pointerup(handle, 600, 0);
    // Default storageKey is 'koine.studio.groupSize'.
    expect(localStorage.getItem('koine.studio.groupSize')).toBe('400');
  });

  test('honours an explicit storageKey', () => {
    const split = document.createElement('div');
    const handle = document.createElement('div');
    document.body.appendChild(split);
    document.body.appendChild(handle);
    stubRect(split, { left: 0, right: 1000, width: 1000 });

    initGroupResizer({ split, handle, orientation: 'horizontal', storageKey: 'custom.group.key' });

    pointerdown(handle, 1000, 0);
    pointermove(handle, 500, 0); // 500px
    pointerup(handle, 500, 0);
    expect(localStorage.getItem('custom.group.key')).toBe('500');
  });

  test('restores a persisted group width under the default key on init', () => {
    const split = document.createElement('div');
    const handle = document.createElement('div');
    document.body.appendChild(split);
    document.body.appendChild(handle);
    stubRect(split, { left: 0, right: 1000, width: 1000 });
    localStorage.setItem('koine.studio.groupSize', '350');

    initGroupResizer({ split, handle, orientation: 'horizontal' });
    expect(sizeOf(split, '--koi-group-w')).toBe(350);
  });
});

describe('initGroupResizer — vertical orientation (stacked, horizontal divider)', () => {
  test('drives --koi-group-h anchored to the bottom of split and persists under the default key', () => {
    const split = document.createElement('div');
    const handle = document.createElement('div');
    document.body.appendChild(split);
    document.body.appendChild(handle);
    stubRect(split, { top: 0, bottom: 800, height: 800 });

    initGroupResizer({ split, handle, orientation: 'vertical' });

    pointerdown(handle, 0, 800);
    pointermove(handle, 0, 500); // 300px up from the bottom edge
    expect(sizeOf(split, '--koi-group-h')).toBe(300);

    pointerup(handle, 0, 500);
    // Default storageKey is 'koine.studio.groupSize'.
    expect(localStorage.getItem('koine.studio.groupSize')).toBe('300');
  });

  test('honours an explicit storageKey', () => {
    const split = document.createElement('div');
    const handle = document.createElement('div');
    document.body.appendChild(split);
    document.body.appendChild(handle);
    stubRect(split, { top: 0, bottom: 800, height: 800 });

    initGroupResizer({ split, handle, orientation: 'vertical', storageKey: 'custom.group.h.key' });

    pointerdown(handle, 0, 800);
    pointermove(handle, 0, 600); // 200px
    pointerup(handle, 0, 600);
    expect(localStorage.getItem('custom.group.h.key')).toBe('200');
  });

  test('restores a persisted group height under the default key on init', () => {
    const split = document.createElement('div');
    const handle = document.createElement('div');
    document.body.appendChild(split);
    document.body.appendChild(handle);
    stubRect(split, { top: 0, bottom: 800, height: 800 });
    localStorage.setItem('koine.studio.groupSize', '250');

    initGroupResizer({ split, handle, orientation: 'vertical' });
    expect(sizeOf(split, '--koi-group-h')).toBe(250);
  });
});
