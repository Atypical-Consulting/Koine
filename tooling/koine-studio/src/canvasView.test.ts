// Tests for the pure viewBox transform model (issue #145, Task 1). These are framework-free math:
// a `ViewBox` is the SVG `viewBox` rect {x, y, w, h} in CONTENT coordinates, and the four helpers
// move/scale it without ever touching the DOM. The renderer (diagrams-svg.ts) owns the SVG and the
// pointer plumbing; this module owns the geometry, so it can be reasoned about and tested in isolation.
import { describe, expect, test } from 'vitest';
import { zoomAt, panBy, centerOn, fit, viewAtScale, zoomPercent, clampScale, type ViewBox } from './canvasView';

/** The on-screen fractional position of a content point within a viewBox (0..1 along each axis). */
function frac(vb: ViewBox, cx: number, cy: number): { fx: number; fy: number } {
  return { fx: (cx - vb.x) / vb.w, fy: (cy - vb.y) / vb.h };
}

describe('zoomAt', () => {
  test('keeps the anchored content point stable on screen', () => {
    const vb: ViewBox = { x: 0, y: 0, w: 100, h: 100 };
    const cx = 25;
    const cy = 75;
    const before = frac(vb, cx, cy);

    const after = zoomAt(vb, 2, cx, cy);

    // The same content point maps to the same fractional (=screen) position before and after.
    const now = frac(after, cx, cy);
    expect(now.fx).toBeCloseTo(before.fx, 10);
    expect(now.fy).toBeCloseTo(before.fy, 10);
  });

  test('zooming in by a factor > 1 shrinks the visible window (sees less, magnified)', () => {
    const after = zoomAt({ x: 0, y: 0, w: 100, h: 100 }, 2, 50, 50);
    expect(after.w).toBeCloseTo(50, 10);
    expect(after.h).toBeCloseTo(50, 10);
  });

  test('zooming out by a factor < 1 grows the visible window', () => {
    const after = zoomAt({ x: 0, y: 0, w: 100, h: 100 }, 0.5, 50, 50);
    expect(after.w).toBeCloseTo(200, 10);
    expect(after.h).toBeCloseTo(200, 10);
  });

  test('anchoring at a corner keeps that corner pinned', () => {
    // Anchor at the top-left content corner (0,0): zooming must not move it off (0,0).
    const after = zoomAt({ x: 0, y: 0, w: 100, h: 100 }, 4, 0, 0);
    expect(after.x).toBeCloseTo(0, 10);
    expect(after.y).toBeCloseTo(0, 10);
    expect(after.w).toBeCloseTo(25, 10);
  });
});

describe('panBy', () => {
  test('shifts the origin by the given content delta, size unchanged', () => {
    expect(panBy({ x: 0, y: 0, w: 100, h: 100 }, 10, -5)).toEqual({ x: 10, y: -5, w: 100, h: 100 });
  });

  test('is additive', () => {
    const once = panBy({ x: 3, y: 4, w: 100, h: 100 }, 10, 20);
    const twice = panBy(once, -10, -20);
    expect(twice).toEqual({ x: 3, y: 4, w: 100, h: 100 });
  });
});

describe('centerOn', () => {
  test('moves the window center to the point, keeping its size', () => {
    const vb: ViewBox = { x: 0, y: 0, w: 40, h: 20 };
    const out = centerOn(vb, 100, 50);
    expect(out.w).toBe(40);
    expect(out.h).toBe(20);
    expect(out.x + out.w / 2).toBeCloseTo(100, 10);
    expect(out.y + out.h / 2).toBeCloseTo(50, 10);
  });
});

describe('fit', () => {
  test('centers content within the viewport with the requested padding', () => {
    // Content 200x100 into a square 400x400 viewport, padding 10. Content is wider than the viewport's
    // aspect, so the viewBox grows vertically to match — and the content center stays the viewBox center.
    const vb = fit({ x: 0, y: 0, w: 200, h: 100 }, { w: 400, h: 400 }, 10);

    // The viewBox matches the viewport aspect ratio so the rendered scale is uniform (no distortion).
    expect(vb.w / vb.h).toBeCloseTo(400 / 400, 10);

    // The padded content (220 wide) sets the constraining dimension; height expands to keep the aspect.
    expect(vb.w).toBeCloseTo(220, 10);
    expect(vb.h).toBeCloseTo(220, 10);

    // Content center (100, 50) sits dead-center of the viewBox.
    expect(vb.x + vb.w / 2).toBeCloseTo(100, 10);
    expect(vb.y + vb.h / 2).toBeCloseTo(50, 10);
  });

  test('fully contains the padded content on both axes', () => {
    const content = { x: 12, y: 30, w: 300, h: 220 };
    const padding = 16;
    const vb = fit(content, { w: 640, h: 360 }, padding);
    // Every padded edge is inside the viewBox.
    expect(vb.x).toBeLessThanOrEqual(content.x - padding + 1e-6);
    expect(vb.y).toBeLessThanOrEqual(content.y - padding + 1e-6);
    expect(vb.x + vb.w).toBeGreaterThanOrEqual(content.x + content.w + padding - 1e-6);
    expect(vb.y + vb.h).toBeGreaterThanOrEqual(content.y + content.h + padding - 1e-6);
  });

  test('a degenerate (zero-size) viewport falls back to the padded content box without dividing by zero', () => {
    const vb = fit({ x: 0, y: 0, w: 100, h: 50 }, { w: 0, h: 0 }, 5);
    expect(Number.isFinite(vb.w)).toBe(true);
    expect(Number.isFinite(vb.h)).toBe(true);
    expect(vb.w).toBeGreaterThan(0);
    expect(vb.h).toBeGreaterThan(0);
  });
});

describe('viewAtScale', () => {
  test('scale 1 (100%) makes the viewBox the viewport size, centered on the content', () => {
    // 100% means one content unit per pixel: the window's size equals the viewport's pixel size, so
    // zoomPercent reads exactly 100, and it's centered on the diagram regardless of the content size.
    const content = { x: 10, y: 20, w: 300, h: 200 };
    const viewport = { w: 800, h: 600 };
    const vb = viewAtScale(content, viewport, 1);

    expect(vb.w).toBeCloseTo(800, 10);
    expect(vb.h).toBeCloseTo(600, 10);
    expect(vb.x + vb.w / 2).toBeCloseTo(content.x + content.w / 2, 10);
    expect(vb.y + vb.h / 2).toBeCloseTo(content.y + content.h / 2, 10);
    expect(zoomPercent(vb, viewport)).toBe(100);
  });

  test('scale 2 (200%) halves the window so the content shows magnified, still centered', () => {
    const content = { x: 0, y: 0, w: 400, h: 400 };
    const viewport = { w: 800, h: 800 };
    const vb = viewAtScale(content, viewport, 2);

    expect(vb.w).toBeCloseTo(400, 10);
    expect(vb.h).toBeCloseTo(400, 10);
    expect(vb.x + vb.w / 2).toBeCloseTo(200, 10);
    expect(zoomPercent(vb, viewport)).toBe(200);
  });

  test('a degenerate (zero-size) viewport falls back to the content size without dividing by zero', () => {
    const vb = viewAtScale({ x: 0, y: 0, w: 100, h: 50 }, { w: 0, h: 0 }, 1);
    expect(Number.isFinite(vb.w)).toBe(true);
    expect(Number.isFinite(vb.h)).toBe(true);
    expect(vb.w).toBeGreaterThan(0);
    expect(vb.h).toBeGreaterThan(0);
  });
});

describe('zoomPercent', () => {
  test('reads 100% when the viewBox width equals the viewport width', () => {
    expect(zoomPercent({ x: 0, y: 0, w: 400, h: 400 }, { w: 400, h: 400 })).toBe(100);
  });

  test('halving the viewBox doubles the zoom; doubling it halves the zoom', () => {
    expect(zoomPercent({ x: 0, y: 0, w: 200, h: 200 }, { w: 400, h: 400 })).toBe(200);
    expect(zoomPercent({ x: 0, y: 0, w: 800, h: 800 }, { w: 400, h: 400 })).toBe(50);
  });

  test('round-trips through fit: fitting content with no padding yields the scale fit implies', () => {
    // Content with the same aspect as the viewport, fit with zero padding → the viewBox equals the
    // content box, so the reported zoom is exactly viewport/content along the width.
    const viewport = { w: 800, h: 400 };
    const content = { x: 0, y: 0, w: 400, h: 200 }; // same 2:1 aspect as the viewport
    const vb = fit(content, viewport, 0);
    expect(vb.w).toBeCloseTo(400, 10);
    expect(zoomPercent(vb, viewport)).toBe(200);
  });
});

describe('clampScale', () => {
  test('returns a zoom factor that never drives the scale past the [min,max] bounds', () => {
    // At scale 1.0 (vb.w == viewport.w) a 100x zoom-in request is clamped so the resulting scale ≤ max.
    const vb: ViewBox = { x: 0, y: 0, w: 400, h: 400 };
    const viewport = { w: 400, h: 400 };
    const f = clampScale(vb, viewport, 100, 0.2, 4);
    const after = zoomAt(vb, f, 200, 200);
    const scale = viewport.w / after.w;
    expect(scale).toBeLessThanOrEqual(4 + 1e-9);
    expect(scale).toBeGreaterThan(1); // it still zoomed in, just not all the way to 100x
  });

  test('clamps a zoom-out request to the minimum scale', () => {
    const vb: ViewBox = { x: 0, y: 0, w: 400, h: 400 };
    const viewport = { w: 400, h: 400 };
    const f = clampScale(vb, viewport, 0.001, 0.2, 4);
    const after = zoomAt(vb, f, 200, 200);
    const scale = viewport.w / after.w;
    expect(scale).toBeGreaterThanOrEqual(0.2 - 1e-9);
  });

  test('leaves an in-range request untouched', () => {
    const vb: ViewBox = { x: 0, y: 0, w: 400, h: 400 };
    const viewport = { w: 400, h: 400 };
    // Current scale is 1.0; a 1.5x zoom lands at 1.5, well inside [0.2, 4].
    expect(clampScale(vb, viewport, 1.5, 0.2, 4)).toBeCloseTo(1.5, 10);
  });
});
