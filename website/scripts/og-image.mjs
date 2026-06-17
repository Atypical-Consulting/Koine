// Renders the social-share card (Open Graph / Twitter) into website/public/og.png.
// 1200×630, the "architectural blueprint" brand look from src/styles/tokens.css.
// Run via `npm run build:og`; invoked automatically by predev/prebuild alongside build-wasm.
//
// Rasterises an inline SVG with sharp (already a dependency). Text uses generic
// sans-serif/monospace families so it renders with whatever fonts the build host has
// (DejaVu on CI) — no font embedding needed. Cross-platform, no extra deps.
import sharp from 'sharp';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const websiteDir = resolve(here, '..');
const out = join(websiteDir, 'public', 'og.png');

const W = 1200;
const H = 630;

// Brand tokens (light "paper" theme) — kept in sync with src/styles/tokens.css.
const paper = '#f6f8fc';
const surface = '#ffffff';
const ink = '#141a33';
const inkSoft = '#44507a';
const indigo = '#3245b8';
const cyan = '#16a6c4';
const line = '#c9d4ec';
const grid = 'rgba(50, 69, 184, 0.07)';
const gridStrong = 'rgba(50, 69, 184, 0.14)';

const sans = 'Archivo, Hanken Grotesk, Helvetica, Arial, sans-serif';
const mono = 'JetBrains Mono, DejaVu Sans Mono, Menlo, Consolas, monospace';

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <pattern id="g" width="28" height="28" patternUnits="userSpaceOnUse">
      <path d="M28 0H0V28" fill="none" stroke="${grid}" stroke-width="1"/>
    </pattern>
    <pattern id="G" width="140" height="140" patternUnits="userSpaceOnUse">
      <path d="M140 0H0V140" fill="none" stroke="${gridStrong}" stroke-width="1"/>
    </pattern>
  </defs>

  <rect width="${W}" height="${H}" fill="${paper}"/>
  <rect width="${W}" height="${H}" fill="url(#g)"/>
  <rect width="${W}" height="${H}" fill="url(#G)"/>
  <rect x="0" y="0" width="${W}" height="10" fill="${indigo}"/>

  <!-- Wordmark -->
  <text x="80" y="150" font-family="${sans}" font-weight="800" font-size="76" letter-spacing="-2">
    <tspan fill="${indigo}">&#922;</tspan><tspan fill="${ink}">oine</tspan>
  </text>

  <!-- Eyebrow -->
  <text x="84" y="196" font-family="${mono}" font-size="22" letter-spacing="1" fill="${inkSoft}">${esc(
    'Κοινή · a DSL for Domain-Driven Design'
  )}</text>

  <!-- Headline -->
  <text x="80" y="300" font-family="${sans}" font-weight="800" font-size="68" letter-spacing="-2" fill="${ink}">Model the domain.</text>
  <text x="80" y="376" font-family="${sans}" font-weight="800" font-size="68" letter-spacing="-2"><tspan fill="${indigo}">Compile</tspan><tspan fill="${ink}" dx="20">the code.</tspan></text>

  <!-- Subhead -->
  <text x="80" y="438" font-family="${sans}" font-size="28" fill="${inkSoft}">Write the ubiquitous language once → generate idiomatic, self-contained C#.</text>

  <!-- model.koi → .cs chips -->
  <g transform="translate(80 480)">
    <rect x="0" y="0" width="270" height="90" rx="10" fill="${surface}" stroke="${line}"/>
    <text x="20" y="34" font-family="${mono}" font-size="18" fill="${inkSoft}">model.koi</text>
    <text x="20" y="64" font-family="${mono}" font-size="20" fill="${indigo}">value Money { … }</text>

    <text x="300" y="58" font-family="${mono}" font-size="34" fill="${cyan}">→</text>

    <rect x="350" y="0" width="270" height="90" rx="10" fill="${surface}" stroke="${line}"/>
    <text x="370" y="34" font-family="${mono}" font-size="18" fill="${inkSoft}">Money.cs</text>
    <text x="370" y="64" font-family="${mono}" font-size="20" fill="${ink}">sealed class Money</text>
  </g>

  <!-- URL -->
  <text x="${
    W - 80
  }" y="585" text-anchor="end" font-family="${mono}" font-size="22" fill="${inkSoft}">atypical-consulting.github.io/Koine</text>
</svg>`;

mkdirSync(dirname(out), { recursive: true });
const png = await sharp(Buffer.from(svg)).png().toBuffer();
writeFileSync(out, png);
console.log(`> wrote ${out} (${png.length} bytes)`);
