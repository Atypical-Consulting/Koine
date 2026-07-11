// Mirrors $bp-narrow in src/styles/abstracts/_variables.scss — keep the two values in sync.
export const BP_NARROW = 640;

/**
 * True on a phone-width (narrow) viewport — the JS mirror of the `$bp-narrow` media query. The single
 * definition every shell module shares, so "narrow" means exactly one thing (do NOT re-derive the
 * `window.innerWidth <= BP_NARROW` comparison anywhere). For the editor's hot edit path, cache this via
 * a `matchMedia` listener rather than calling it per keystroke.
 */
export const isNarrowViewport = (): boolean => window.innerWidth <= BP_NARROW;

/** A `resize`-event handler that fires `onCross(narrow)` only when the viewport actually crosses
 *  $bp-narrow: it tracks its own last-narrow-ness (seeded at creation) so a resize TICK that doesn't
 *  cross the breakpoint is a no-op — on mobile the soft keyboard / address bar fire `resize` constantly,
 *  and reacting to every tick would thrash the UI. Each consumer creates, registers, and detaches its
 *  OWN handler (its own independent crossing state) rather than sharing one. */
export function createNarrowCrossHandler(onCross: (narrow: boolean) => void): () => void {
  let wasNarrow = isNarrowViewport();
  return () => {
    const narrow = isNarrowViewport();
    if (narrow === wasNarrow) return; // not a cross — ignore the keyboard/address-bar resize churn
    wasNarrow = narrow;
    onCross(narrow);
  };
}
