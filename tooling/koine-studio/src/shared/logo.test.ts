import { describe, it, expect } from 'vitest';
// The committed file-based copy of the mark, inlined as a string (Vite `?raw`). The favicon, PWA
// icons, README and website all derive from this brand family, so it is the canonical geometry the
// runtime builder must not drift from.
import brandMarkSvg from '@/assets/brand/koine-mark.svg?raw';
import { koineMark } from '@/shared/logo';

// The hexagon-κ geometry — the shared truth the builder and every file-based copy must agree on.
const HEX_POINTS = '106,60 83,99.84 37,99.84 14,60 37,20.16 83,20.16';
const KAPPA_STROKES = ['M48 36 V84', 'M48 60 L78 36', 'M48 60 L78 84'];

describe('koineMark (hexagon-κ)', () => {
  it('draws the ports-and-adapters hexagon', () => {
    expect(koineMark()).toContain(HEX_POINTS);
  });

  it('draws the three κ strokes', () => {
    const svg = koineMark();
    for (const d of KAPPA_STROKES) expect(svg).toContain(d);
  });

  it('is single-ink and theme-tracking — stroke bound to --koi-accent, never a hardcoded accent hex', () => {
    const svg = koineMark();
    expect(svg).toContain('stroke="var(--koi-accent)"');
    // No literal accent colour that would ignore the active theme (dark #5aa9ff / light #2f7fe0),
    // and no leftover gradient from the old "K" monogram.
    expect(svg).not.toContain('#5aa9ff');
    expect(svg).not.toContain('#2f7fe0');
    expect(svg).not.toContain('linearGradient');
  });

  it('renders on the 120×120 handoff grid', () => {
    expect(koineMark()).toContain('viewBox="0 0 120 120"');
  });

  it('exposes an accessible image role and name', () => {
    const svg = koineMark();
    expect(svg).toContain('role="img"');
    expect(svg).toContain('aria-label="Koine"');
  });

  it('is id-free and deterministic — every call returns the identical mark, so copies never collide', () => {
    expect(koineMark()).toBe(koineMark());
  });

  it('stays geometry-synced with the committed brand SVG (src/assets/brand/koine-mark.svg)', () => {
    // Only the ink differs between the two (file #5aa9ff vs builder var(--koi-accent) so it can theme
    // it live) — the hexagon and κ geometry must match exactly, or the in-app mark has drifted from
    // the file the favicon/PWA/README/website all derive from.
    expect(brandMarkSvg).toContain(HEX_POINTS);
    for (const d of KAPPA_STROKES) expect(brandMarkSvg).toContain(d);
    const svg = koineMark();
    expect(svg).toContain(HEX_POINTS);
    for (const d of KAPPA_STROKES) expect(svg).toContain(d);
  });
});
