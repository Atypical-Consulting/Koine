// Generates the PWA Web App Manifest for Koine Studio's web build. The core (`buildManifest`) is a
// pure function exported so both the vite plugin (pwaManifestPlugin in vite.config.ts) and the vitest
// suite drive the identical logic. The manifest's navigational fields (start_url/scope) and icon srcs
// are prefixed by the Vite `base` (KOINE_STUDIO_BASE) so the same code installs correctly whether the
// studio is served from the site root ('/') or a sub-path ('/Koine/studio/'). Mirrors the .mjs style
// of generate-templates.mjs / build-wasm.mjs. No deps beyond Node's stdlib.

/** The brand dark surface (matches --koi-paper in the dark theme); the OS chrome tint when installed. */
const THEME_COLOR = '#0e1117';
/** Splash-screen background while the app boots; same brand dark so there's no flash. */
const BACKGROUND_COLOR = '#0e1117';

/**
 * Normalise a Vite `base` to a leading-and-trailing-slashed prefix so joining never produces a
 * doubled `//` or a missing separator. `''`/`'/'` → `'/'`; `'/Koine/studio'` → `'/Koine/studio/'`.
 * @param {string} base
 * @returns {string}
 */
export function normalizeBase(base) {
  if (!base || base === '/') return '/';
  let b = String(base);
  if (!b.startsWith('/') && !/^https?:\/\//.test(b)) b = '/' + b;
  if (!b.endsWith('/')) b = b + '/';
  return b;
}

/**
 * Build the PWA manifest object for a given Vite base.
 * @param {string} [base='/'] the Vite base (e.g. '/' or '/Koine/studio/').
 * @returns {{
 *   name: string; short_name: string; description: string;
 *   start_url: string; scope: string; id: string;
 *   display: string; orientation: string;
 *   background_color: string; theme_color: string;
 *   icons: { src: string; sizes: string; type: string; purpose: string }[];
 * }}
 */
export function buildManifest(base = '/') {
  const b = normalizeBase(base);
  return {
    name: 'Koine Studio',
    short_name: 'Koine',
    description:
      "Write a bounded context's ubiquitous language once and generate idiomatic, self-contained " +
      'code (C#, TypeScript, Python, PHP) with live diagnostics, a domain diagram and an AI domain copilot.',
    id: b,
    start_url: b,
    scope: b,
    display: 'standalone',
    orientation: 'any',
    background_color: BACKGROUND_COLOR,
    theme_color: THEME_COLOR,
    icons: [
      { src: `${b}icons/icon-192.png`, sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: `${b}icons/icon-512.png`, sizes: '512x512', type: 'image/png', purpose: 'any' },
      {
        src: `${b}icons/icon-512-maskable.png`,
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  };
}

/** Pretty-printed manifest JSON for emission as `manifest.webmanifest`. */
export function renderManifest(base = '/') {
  return JSON.stringify(buildManifest(base), null, 2) + '\n';
}
