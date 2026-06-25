// Mirrors $bp-narrow in src/styles/abstracts/_variables.scss — keep the two values in sync.
export const BP_NARROW = 640;

/**
 * True on a phone-width (narrow) viewport — the JS mirror of the `$bp-narrow` media query. The single
 * definition every shell module shares, so "narrow" means exactly one thing (do NOT re-derive the
 * `window.innerWidth <= BP_NARROW` comparison anywhere). For the editor's hot edit path, cache this via
 * a `matchMedia` listener rather than calling it per keystroke.
 */
export const isNarrowViewport = (): boolean => window.innerWidth <= BP_NARROW;
