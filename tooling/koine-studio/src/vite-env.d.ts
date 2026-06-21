/// <reference types="vite/client" />

// CSS-only font packages (no bundled types) — allow their side-effect imports in main.ts.
declare module '@fontsource-variable/*';

// Build-time define (vite.config.ts: `define: { __APP_VERSION__: pkg.version }`) — the app version,
// surfaced in the status bar and the About chip.
declare const __APP_VERSION__: string;
