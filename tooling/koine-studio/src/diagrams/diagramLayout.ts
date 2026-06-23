// Pure, DOM-free geometry for the diagram canvas (the n8n-grade authoring overhaul): where an edge
// attaches to a node's border, where the per-end cardinality labels sit, and how long member text is
// clipped to a node's width. Mirrors the canvasView.ts discipline — no DOM, no state, just functions —
// so the renderer's hardest math is unit-tested in isolation and survives the move from elk auto-layout
// (Phase 1) to free, manually-positioned nodes (Phase 2), where elk no longer routes the edges for us.

/** An axis-aligned rectangle in content space (the same units elk / the renderer place nodes in). */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A content-space point. */
export interface Point {
  x: number;
  y: number;
}

/** The geometric center of a rect. */
export function centerOf(r: Rect): Point {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

/**
 * The point on `rect`'s border along the ray from its center toward `toward`. This is what anchors an
 * edge to a node: the connector meets the box exactly on its border (never floating inside it or off in
 * space), for any relative position of the two nodes. Degenerate input (toward == center) returns the
 * center so the math never divides by zero.
 */
export function anchorOnBorder(rect: Rect, toward: Point): Point {
  const c = centerOf(rect);
  const dx = toward.x - c.x;
  const dy = toward.y - c.y;
  if (dx === 0 && dy === 0) return c;
  const hw = rect.w / 2;
  const hh = rect.h / 2;
  // Scale the direction until it just reaches a border: the nearer of the vertical/horizontal crossings
  // is where the ray leaves the rectangle.
  const tx = dx !== 0 ? hw / Math.abs(dx) : Infinity;
  const ty = dy !== 0 ? hh / Math.abs(dy) : Infinity;
  const t = Math.min(tx, ty);
  return { x: c.x + dx * t, y: c.y + dy * t };
}

/** A routed edge: the two border endpoints plus the anchor points for the per-end cardinality labels. */
export interface EdgeRoute {
  start: Point; // on the source node's border
  end: Point; // on the target node's border
  sourceLabel: Point; // where the source-end multiplicity sits (just inside `start`)
  targetLabel: Point; // where the target-end multiplicity sits (just inside `end`)
  mid: Point; // segment midpoint (the semantic label: a relation kind / transition guard / publish verb)
}

const CARD_OFFSET = 18; // how far back from an endpoint a cardinality label sits, along the segment
const CARD_LIFT = 8; // how far the cardinality label is nudged perpendicular to the segment (off the line)

/**
 * Route an edge from `src` to `dst`: anchor both ends on the node borders (so the connector always
 * touches the boxes), and place a cardinality-label anchor just inside each end — offset back along the
 * segment and lifted a little off the line so the multiplicity text doesn't sit on top of the stroke.
 * `mid` is the segment midpoint, for a semantic edge label.
 */
export function edgeRoute(src: Rect, dst: Rect): EdgeRoute {
  const start = anchorOnBorder(src, centerOf(dst));
  const end = anchorOnBorder(dst, centerOf(src));
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  // Perpendicular unit (the direction rotated 90°) for lifting a label off the line.
  const px = -uy;
  const py = ux;
  const off = Math.min(CARD_OFFSET, len / 2);
  return {
    start,
    end,
    sourceLabel: { x: start.x + ux * off + px * CARD_LIFT, y: start.y + uy * off + py * CARD_LIFT },
    targetLabel: { x: end.x - ux * off + px * CARD_LIFT, y: end.y - uy * off + py * CARD_LIFT },
    mid: { x: start.x + dx / 2, y: start.y + dy / 2 },
  };
}

/**
 * Truncate `text` so it fits within `maxPx` at the given average character width, appending an ellipsis
 * when it had to cut. Returns the original string untouched when it already fits — so callers can detect
 * that a truncation happened (and attach a full-text `<title>`) via `result !== text`. SVG `<text>` has
 * no native ellipsis, so this is how a node keeps a hard width cap without overflowing.
 */
export function truncateToWidth(text: string, maxPx: number, charWidth: number): string {
  if (text.length === 0) return text;
  if (charWidth <= 0 || maxPx <= 0) return '…';
  const maxChars = Math.floor(maxPx / charWidth);
  if (text.length <= maxChars) return text;
  if (maxChars <= 1) return '…';
  return text.slice(0, maxChars - 1).trimEnd() + '…';
}
