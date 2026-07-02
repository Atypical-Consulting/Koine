// Patches the storybook reference (.design-sync/sb-reference) so the compare ORACLE reflects the design
// @atypical/koine-ui actually intends — same discipline the design-sync skill prescribes for fonts.
//
// Two gaps between the repo's storybook build and the shipped design, both of which would otherwise make
// every grade a comparison against a WRONG reference:
//   1. Background. .storybook/preview.ts sets `backgrounds.default: 'studio'` (#15161a) because these
//      components are built for Koine Studio's dark shell — but that addon parameter is NOT applied in a
//      static `?story=` capture, so the reference renders the DS's light-ink components on a white canvas
//      (their text becomes nearly invisible). We paint the real dark ground (var(--koi-paper)).
//   2. Fonts. The storybook never imports the brand fonts (JetBrains Mono / Hanken Grotesk); the shipped
//      bundle does. We copy the bundle's fonts into the reference and @font-face them so BOTH sides render
//      the real families instead of grading real-font vs system-fallback.
//
// Idempotent (a marker guards re-injection). Re-run whenever the reference is rebuilt (see buildCmd/NOTES).
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, copyFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ref = resolve(repoRoot, '.design-sync/sb-reference');
const bundleFonts = resolve(repoRoot, 'ds-bundle/fonts');
const iframe = join(ref, 'iframe.html');

if (!existsSync(iframe)) throw new Error(`patch-reference: ${iframe} not found — build the reference storybook first`);

// 1. Copy the shipped fonts into the reference so @font-face url()s resolve when compare serves it.
if (existsSync(bundleFonts)) {
  const dst = join(ref, 'fonts');
  mkdirSync(dst, { recursive: true });
  for (const f of readdirSync(bundleFonts)) copyFileSync(join(bundleFonts, f), join(dst, f));
}

// 2. Inject the parity <style> (dark ground + light ink + brand fonts) once.
let html = readFileSync(iframe, 'utf8');
const MARKER = 'ds-sync-reference-parity';
if (!html.includes(MARKER)) {
  const inject =
    `<link rel="stylesheet" href="./fonts/fonts.css">` +
    `<style id="${MARKER}">html,body{background:var(--koi-paper);color:var(--koi-fg);` +
    `font-family:var(--koi-font-body);}</style>`;
  html = html.replace('</head>', `${inject}</head>`);
  writeFileSync(iframe, html);
  console.error('patch-reference: injected dark-surface + brand-font parity into sb-reference/iframe.html');
} else {
  console.error('patch-reference: parity already present (fonts refreshed)');
}
