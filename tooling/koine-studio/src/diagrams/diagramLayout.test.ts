// Tests for the pure diagram-layout geometry (the n8n-grade canvas overhaul): edges anchor on node
// borders, per-end cardinality labels sit just inside each endpoint, and over-long member text clips to
// a width with an ellipsis. All DOM-free, so they run as plain math (mirrors canvasView.test.ts).
import { describe, expect, test } from 'vitest';
import { anchorOnBorder, centerOf, edgeRoute, truncateToWidth, type Rect } from '@/diagrams/diagramLayout';

const RECT: Rect = { x: 0, y: 0, w: 100, h: 50 }; // center (50, 25)

/** True when `p` lies on `r`'s border (within epsilon) and inside its extent. */
function onBorder(p: { x: number; y: number }, r: Rect): boolean {
  const eps = 1e-6;
  const onVertical = Math.abs(p.x - r.x) < eps || Math.abs(p.x - (r.x + r.w)) < eps;
  const onHorizontal = Math.abs(p.y - r.y) < eps || Math.abs(p.y - (r.y + r.h)) < eps;
  const insideX = p.x >= r.x - eps && p.x <= r.x + r.w + eps;
  const insideY = p.y >= r.y - eps && p.y <= r.y + r.h + eps;
  return ((onVertical && insideY) || (onHorizontal && insideX));
}

describe('anchorOnBorder', () => {
  test('a point due east of the center anchors on the right border', () => {
    const p = anchorOnBorder(RECT, { x: 200, y: 25 });
    expect(p).toEqual({ x: 100, y: 25 });
    expect(onBorder(p, RECT)).toBe(true);
  });

  test('a point due north anchors on the top border', () => {
    const p = anchorOnBorder(RECT, { x: 50, y: -100 });
    expect(p).toEqual({ x: 50, y: 0 });
  });

  test('a point due west anchors on the left border', () => {
    const p = anchorOnBorder(RECT, { x: -50, y: 25 });
    expect(p).toEqual({ x: 0, y: 25 });
  });

  test('a diagonal target anchors on a corner when the rect aspect matches the direction', () => {
    // direction (100, 50) matches the rect's half-extents (50, 25) → it leaves exactly at the corner.
    const p = anchorOnBorder(RECT, { x: 150, y: 75 });
    expect(p).toEqual({ x: 100, y: 50 });
  });

  test('a target at the center returns the center (no division by zero)', () => {
    expect(anchorOnBorder(RECT, centerOf(RECT))).toEqual({ x: 50, y: 25 });
  });

  test('every cardinal/diagonal anchor lands on the border', () => {
    for (const toward of [
      { x: 999, y: 25 },
      { x: -999, y: 25 },
      { x: 50, y: 999 },
      { x: 50, y: -999 },
      { x: 999, y: 999 },
      { x: -999, y: -40 },
    ]) {
      expect(onBorder(anchorOnBorder(RECT, toward), RECT)).toBe(true);
    }
  });
});

describe('edgeRoute', () => {
  const SRC: Rect = { x: 0, y: 0, w: 100, h: 50 };
  const DST: Rect = { x: 200, y: 0, w: 100, h: 50 };

  test('anchors both ends on the facing borders of the two nodes', () => {
    const r = edgeRoute(SRC, DST);
    expect(r.start).toEqual({ x: 100, y: 25 }); // SRC right border
    expect(r.end).toEqual({ x: 200, y: 25 }); // DST left border
    expect(onBorder(r.start, SRC)).toBe(true);
    expect(onBorder(r.end, DST)).toBe(true);
  });

  test('the mid point is the segment midpoint (for a semantic label)', () => {
    expect(edgeRoute(SRC, DST).mid).toEqual({ x: 150, y: 25 });
  });

  test('the per-end cardinality anchors sit inside each endpoint, lifted off the line', () => {
    const r = edgeRoute(SRC, DST);
    // Along a horizontal edge, the source label is to the RIGHT of start, the target label LEFT of end,
    // and both are nudged off the line (y != 25).
    expect(r.sourceLabel.x).toBeGreaterThan(r.start.x);
    expect(r.targetLabel.x).toBeLessThan(r.end.x);
    expect(r.sourceLabel.y).not.toBe(25);
    expect(r.targetLabel.y).not.toBe(25);
  });
});

describe('truncateToWidth', () => {
  test('returns the text unchanged when it already fits', () => {
    expect(truncateToWidth('Order', 1000, 7)).toBe('Order');
  });

  test('clips with an ellipsis when too wide, staying within the char budget', () => {
    const long = 'a'.repeat(100);
    const out = truncateToWidth(long, 70, 7); // maxChars = 10
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(10);
    expect(out).not.toBe(long);
  });

  test('empty text stays empty', () => {
    expect(truncateToWidth('', 70, 7)).toBe('');
  });

  test('a degenerate width yields just the ellipsis', () => {
    expect(truncateToWidth('anything', 0, 7)).toBe('…');
  });
});
