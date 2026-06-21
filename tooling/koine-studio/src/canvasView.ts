// Pure viewBox transform model for the interactive diagram canvas (issue #145, Task 1).
//
// The SVG diagram renderer (diagrams-svg.ts) draws each graph into an `<svg>` whose intrinsic size is
// the laid-out content box. Zoom / pan / fit / minimap are then expressed purely as a moving window over
// that content — the SVG `viewBox` — so the picture stays crisp at any scale (vector, not a CSS bitmap
// scale) and the layout (elkjs) never re-runs. This module is that window's geometry: it has NO DOM and
// NO state, just functions from one `ViewBox` to the next, which keeps the math testable in isolation and
// the renderer free to own the SVG and the pointer plumbing.
//
// All coordinates are in CONTENT space — the same units the renderer used to place nodes — so a
// `ViewBox` plugged straight into `svg.setAttribute('viewBox', ...)` shows exactly that region.

/** The SVG `viewBox` rectangle: the content-space window currently shown on the canvas. */
export interface ViewBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A content-space rectangle (e.g. the full laid-out diagram bounds). */
export interface Bounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A pixel size (e.g. the canvas surface's client rect). */
export interface Size {
  w: number;
  h: number;
}

/**
 * Zoom the window by `factor` while keeping the content point `(cx, cy)` pinned to its current on-screen
 * spot. `factor > 1` zooms IN (the window shrinks, so the same screen shows less content, magnified);
 * `factor < 1` zooms OUT. The anchor stays fixed because we hold its *fractional* position within the
 * viewBox constant — that fraction is exactly where it lands on screen under any `preserveAspectRatio`.
 */
export function zoomAt(vb: ViewBox, factor: number, cx: number, cy: number): ViewBox {
  const w = vb.w / factor;
  const h = vb.h / factor;
  // Solve (cx - x') / w' == (cx - x) / w  ⇒  x' = cx - (cx - x) / factor.
  const x = cx - (cx - vb.x) / factor;
  const y = cy - (cy - vb.y) / factor;
  return { x, y, w, h };
}

/** Slide the window by a content-space delta, leaving its size (zoom) unchanged. */
export function panBy(vb: ViewBox, dx: number, dy: number): ViewBox {
  return { x: vb.x + dx, y: vb.y + dy, w: vb.w, h: vb.h };
}

/**
 * The window that frames `content` inside `viewport` with `padding` content-units of margin on every
 * side, centered. The returned viewBox is grown to the viewport's aspect ratio so the rendered scale is
 * uniform (no axis is stretched) and the padded content is fully contained on both axes. A degenerate
 * (zero-area) viewport falls back to a square aspect so the math never divides by zero.
 */
export function fit(content: Bounds, viewport: Size, padding: number): ViewBox {
  // The padded content region we must contain.
  const pw = content.w + padding * 2;
  const ph = content.h + padding * 2;
  const px = content.x - padding;
  const py = content.y - padding;
  const cx = px + pw / 2;
  const cy = py + ph / 2;

  const viewAspect = viewport.w > 0 && viewport.h > 0 ? viewport.w / viewport.h : 1;
  const contentAspect = ph > 0 ? pw / ph : viewAspect;

  // Grow whichever axis has slack so the viewBox aspect matches the viewport, keeping content centered.
  let w = pw;
  let h = ph;
  if (contentAspect > viewAspect) {
    h = w / viewAspect; // content too wide → add vertical slack
  } else {
    w = h * viewAspect; // content too tall → add horizontal slack
  }
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

/**
 * The current zoom as a percentage, where 100% means one content unit maps to one viewport pixel along
 * the width (`vb.w === viewport.w`). Returned rounded to a whole percent for the on-screen readout.
 */
export function zoomPercent(vb: ViewBox, viewport: Size): number {
  if (vb.w <= 0 || viewport.w <= 0) return 100;
  return Math.round((viewport.w / vb.w) * 100);
}

/**
 * Clamp a requested zoom `factor` so the resulting scale stays within `[minScale, maxScale]` (scale =
 * viewport / viewBox width, i.e. pixels per content unit). Returns the largest-magnitude factor that
 * keeps the scale in range — so a wild wheel/pinch request settles exactly at the bound instead of
 * overshooting. The renderer holds the scale limits; this keeps the clamping next to the zoom math.
 */
export function clampScale(
  vb: ViewBox,
  viewport: Size,
  factor: number,
  minScale: number,
  maxScale: number,
): number {
  if (vb.w <= 0 || viewport.w <= 0) return factor;
  const scale = viewport.w / vb.w;
  const target = scale * factor;
  const clamped = Math.min(maxScale, Math.max(minScale, target));
  return clamped / scale;
}
