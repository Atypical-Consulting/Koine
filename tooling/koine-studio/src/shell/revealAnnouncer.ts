// Shared reveal-announce state machine for Studio's event-gated toolbar affordances (#580).
//
// The PWA install affordance (#442) and the service-worker update affordance (#443) both reveal a
// toolbar control asynchronously, and both must announce that arrival to assistive tech exactly once —
// on the hidden→visible edge — via the shared body-level live region (#522). #573 added a
// perceivability gate on top: when the reveal edge fires before the control is actually perceivable
// (its `#app` ancestor is route-hidden), the announcement is *deferred* rather than dropped, then
// flushed once — via the same `announce(...)` — on the next perceivable-and-still-visible edge.
//
// That defer/flush state machine was duplicated near-verbatim across `connectInstallAffordance` and
// `connectUpdateAffordance`; the a11y invariant is subtle and must stay correct in lockstep, so it
// lives here once instead. Each controller keeps owning its DOM (toggling `root.hidden`, wiring its
// buttons/events) and delegates only the announce side to this helper, injecting its own
// `isVisible`/`subscribe`/`announce`/`message` plus the optional perceivability signal.
//
// Pure + dependency-injected so it unit-tests under happy-dom with no real DOM or controller.
// WCAG 2.1 AA status messages (SC 4.1.3): the shared region is polite, so this is the non-urgent path.

export interface RevealAnnouncerOptions {
  /** Whether the affordance's control is currently shown (e.g. `controller.canInstall()` / `canReload()`). */
  isVisible: () => boolean;
  /** Subscribe to controller state changes that may cross the reveal edge; returns an unsubscribe fn. */
  subscribe: (cb: () => void) => () => void;
  /** Polite live-region announcer for the reveal — the shared {@link import('./liveRegion').announce}. */
  announce: (message: string) => void;
  /** What assistive tech hears on the reveal (e.g. `INSTALL_ANNOUNCEMENT` / `UPDATE_ANNOUNCEMENT`). */
  message: string;
  /**
   * Seed for the hidden→visible edge. The markup ships `hidden`, so pass `!dom.root.hidden` to capture
   * the initial DOM state before any toggle; defaults to the current `isVisible()`.
   */
  initiallyVisible?: boolean;
  /**
   * Whether the control is currently perceivable — its `#app` ancestor is route-visible. Defaults to
   * always-perceivable, i.e. announce immediately. When this returns `false` on the reveal edge, the
   * announcement is deferred rather than dropped (#573).
   */
  isPerceivable?: () => boolean;
  /**
   * Subscribe to "became perceivable" edges (e.g. the editor route is shown). Used to flush a deferred
   * announcement; returns an unsubscribe fn disposed with the announcer. Omit to never defer (#573).
   */
  subscribePerceivable?: (cb: () => void) => () => void;
}

/**
 * Wire the reveal-announce + #573 defer/flush state machine to an affordance controller. Announces
 * `message` once on the hidden→visible edge — deferring through a perceivability gate when injected —
 * and returns a disposer that unsubscribes both the visibility and perceivability subscriptions.
 */
export function connectRevealAnnouncer(opts: RevealAnnouncerOptions): () => void {
  const { isVisible, subscribe, announce, message } = opts;
  const isPerceivable = opts.isPerceivable ?? ((): boolean => true);

  // Announce on the hidden→visible edge, so assistive tech hears about the affordance once when it
  // appears — not on every controller notification, nor when it's hidden/dismissed. The shared live
  // region is body-level (#522), so it can announce while the control is still inside a route-hidden
  // `#app`. The perceivability gate (#573) closes that gap: when the reveal edge fires before the
  // control is perceivable, defer the announcement and flush it via the same `announce(...)` once the
  // toolbar becomes perceivable — never dropping it. Seed `wasVisible` from `initiallyVisible` (the
  // caller passes `!dom.root.hidden`, captured before its DOM toggle) so a reveal during the initial
  // `sync()` still fires; this helper stays DOM-agnostic and never reads `dom.root.hidden` itself.
  let wasVisible = opts.initiallyVisible ?? isVisible();
  let pending = false; // a reveal that fired while not perceivable, awaiting a perceivable edge to flush
  const sync = (): void => {
    const visible = isVisible();
    if (visible && !wasVisible) {
      if (isPerceivable()) announce(message);
      else pending = true; // not perceivable yet → defer until it is
    } else if (!visible) {
      pending = false; // hidden/dismissed before it could flush → drop the deferred announcement
    }
    wasVisible = visible;
  };
  const flushPending = (): void => {
    // Flush a deferred reveal once the control is both perceivable and still visible — exactly once.
    if (pending && isPerceivable() && isVisible()) {
      pending = false;
      announce(message);
    }
  };

  const unsub = subscribe(sync);
  const unsubPerceivable = opts.subscribePerceivable?.(flushPending);
  sync(); // evaluate the initial reveal edge immediately

  return () => {
    unsub();
    unsubPerceivable?.();
  };
}
