// The Koine monogram — a rounded "K" tile with the brand gradient (accent → cyan). Shared by the
// welcome overlay and the About dialog; the header in index.html inlines an equivalent mark next to
// the Archivo wordmark. Uses CSS-var stops so it tracks the active theme. The gradient id is
// suffixed per call site to avoid duplicate-id clashes when several copies share the document.
// Keep in sync with src/assets/koine-mark.svg (the favicon, which uses literal colors).

/** Build the monogram SVG with a unique gradient id (default 'w' for the welcome/about tier). */
export function koineMark(idSuffix = 'w'): string {
  const g = `koi-grad-${idSuffix}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" fill="none" role="img" aria-label="Koine">
  <defs>
    <linearGradient id="${g}" x1="2" y1="2" x2="30" y2="30" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="var(--koi-accent)"/>
      <stop offset="1" stop-color="var(--koi-cyan)"/>
    </linearGradient>
  </defs>
  <rect x="1" y="1" width="30" height="30" rx="8.5" fill="url(#${g})"/>
  <rect x="1.6" y="1.6" width="28.8" height="28.8" rx="8" fill="none" stroke="rgba(255,255,255,0.22)" stroke-width="1"/>
  <g fill="var(--koi-on-accent)" transform="translate(6.7,4.7) scale(0.86)">
    <rect x="2" y="3" width="4.4" height="22" rx="1.6"/>
    <path d="M8.2 13.6 18 3h5.6l-9.5 10.3L24 25h-5.9l-7.8-9.3-2.1 2.2z"/>
  </g>
</svg>`;
}

/** The monogram for the welcome overlay and the About dialog. */
export const LOGO_SVG = koineMark('w');
