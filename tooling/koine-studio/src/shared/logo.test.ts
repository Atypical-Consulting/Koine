import { describe, it, expect } from 'vitest';
import { koineMark, LOGO_SVG } from '@/shared/logo';

// The hexagon-κ geometry, kept identical to src/assets/brand/koine-mark.svg (the file-based copy).
// If the design ever moves, update both together — this test is the sync guard.
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

  it('keeps a stable, callable signature (optional idSuffix) so the three call sites are untouched', () => {
    // ide.tsx passes 'h', welcome.ts passes 'home', about.ts passes nothing.
    expect(() => koineMark('h')).not.toThrow();
    expect(() => koineMark('home')).not.toThrow();
    // Single-ink now — no per-call gradient id — so the mark is deterministic across calls.
    expect(koineMark()).toBe(koineMark());
  });

  it('LOGO_SVG is the same hexagon-κ mark', () => {
    expect(LOGO_SVG).toContain(HEX_POINTS);
    expect(LOGO_SVG).toContain('stroke="var(--koi-accent)"');
  });
});
