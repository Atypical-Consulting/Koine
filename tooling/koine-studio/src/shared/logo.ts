// The Koine brand mark — a lowercase kappa (κ) inscribed in the ports-and-adapters hexagon, the
// geometry of hexagonal architecture that Koine is built on. Shared by the header (ide.tsx), the
// welcome overlay (welcome.ts) and the About dialog (about.ts) so the in-app mark has a single
// source. Single-ink and theme-tracking: the whole glyph strokes `var(--koi-accent)`, so it follows
// the active theme for free (dark #5aa9ff / light #2f7fe0) with no per-theme copy — and, being
// id-free, any number of copies in one document render identically and can never collide (the reason
// the old gradient monogram had to mint a unique id per call). Sized purely by CSS (`.brand-logo
// svg`, etc.) — the output carries only a viewBox, no intrinsic width/height. Keep in sync with
// src/assets/brand/koine-mark.svg (the file-based copy used for the favicon, PWA icons, README and
// website); logo.test.ts reads that file and fails if the builder and it ever drift apart.

/** Build the Koine brand mark (the hexagon-κ) as an inline SVG string. Single-ink and deterministic. */
export function koineMark(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" fill="none" role="img" aria-label="Koine">
  <g stroke="var(--koi-accent)" stroke-linejoin="round" stroke-linecap="round">
    <polygon points="106,60 83,99.84 37,99.84 14,60 37,20.16 83,20.16" stroke-width="6"/>
    <g stroke-width="7.5">
      <path d="M48 36 V84"/>
      <path d="M48 60 L78 36"/>
      <path d="M48 60 L78 84"/>
    </g>
  </g>
</svg>`;
}
