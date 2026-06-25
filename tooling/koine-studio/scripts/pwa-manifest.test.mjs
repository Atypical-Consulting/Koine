/**
 * TDD tests for pwa-manifest.mjs — the pure PWA Web App Manifest generator.
 *
 * `buildManifest(base)` must produce a manifest whose navigational fields (`start_url`,
 * `scope`) and icon `src`s are prefixed by the Vite `base` (KOINE_STUDIO_BASE), so the same
 * code deploys at the site root ('/') or under a sub-path ('/Koine/studio/'). It is a pure
 * function (no I/O), so the vite plugin and this test drive the identical logic.
 *
 * Run:  npx vitest run --project '!storybook' pwa-manifest
 */
import { describe, it, expect } from 'vitest';
import { buildManifest } from './pwa-manifest.mjs';

describe('buildManifest — sub-path base', () => {
  const m = buildManifest('/Koine/studio/');

  it('is an installable standalone app', () => {
    expect(m.display).toBe('standalone');
    expect(m.name).toBe('Koine Studio');
    expect(m.short_name).toBe('Koine');
    expect(typeof m.description).toBe('string');
    expect(m.description.length).toBeGreaterThan(0);
  });

  it('prefixes the navigational scope with the base', () => {
    expect(m.start_url).toBe('/Koine/studio/');
    expect(m.scope).toBe('/Koine/studio/');
  });

  it('carries the brand colours', () => {
    expect(m.theme_color).toMatch(/^#[0-9a-fA-F]{6}$/);
    expect(m.background_color).toMatch(/^#[0-9a-fA-F]{6}$/);
    expect(m.orientation).toBe('any');
  });

  it('declares 192, 512 and a maskable icon, all base-prefixed', () => {
    const srcs = m.icons.map((i) => i.src);
    expect(srcs.length).toBeGreaterThanOrEqual(3);
    for (const src of srcs) {
      expect(src.startsWith('/Koine/studio/')).toBe(true);
      expect(src).not.toContain('//'); // never a doubled slash from joining
    }
    const sizes = m.icons.map((i) => i.sizes);
    expect(sizes).toContain('192x192');
    expect(sizes).toContain('512x512');
    expect(m.icons.some((i) => i.purpose === 'maskable')).toBe(true);
  });
});

describe('buildManifest — root base', () => {
  it('yields root-based paths for "/"', () => {
    const m = buildManifest('/');
    expect(m.start_url).toBe('/');
    expect(m.scope).toBe('/');
    for (const i of m.icons) {
      expect(i.src.startsWith('/')).toBe(true);
      expect(i.src).not.toContain('//');
    }
  });

  it('normalises a base missing its trailing slash', () => {
    const m = buildManifest('/Koine/studio');
    expect(m.start_url).toBe('/Koine/studio/');
    expect(m.icons[0].src.startsWith('/Koine/studio/')).toBe(true);
  });

  it('defaults to root when given an empty base', () => {
    const m = buildManifest('');
    expect(m.start_url).toBe('/');
  });
});
