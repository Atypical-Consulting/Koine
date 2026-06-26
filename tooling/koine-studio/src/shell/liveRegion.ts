// Shared polite live-region announcer for transient Studio toolbar affordances (#522).
//
// Studio's toolbar reveals event-gated affordances asynchronously — the PWA install button (#442) when
// the browser fires `beforeinstallprompt`, the service-worker update button (#443) when a new build is
// detected. A sighted user sees the control slide in; for a screen-reader user that change is silent
// unless it's announced. Before this, the two surfaces did it inconsistently: the update affordance
// carried its own inline `role=status`/`aria-live` container, the install affordance announced nothing.
//
// This is the single, deliberate "a new toolbar action just appeared" pattern both affordances share:
// one visually-hidden polite live region, created lazily and reused, whose text alone changes on each
// announcement. It mirrors the a11y convention already used by the project-wizard announcer
// (src/export/generateProjectWizard.ts) and the compiling indicator (#516, src/shell/CompilingIndicator.tsx):
// a `koi-sr-only` `aria-live="polite"` `aria-atomic="true"` node that stays mounted in the accessibility
// tree while only its text content flips — toggling a node's presence in the same update that sets its
// text is unreliable for screen readers, so the region persists once created.
//
// Pure + DOM-light so it unit-tests under happy-dom; a no-op where there's no document (SSR / no-DOM).
// WCAG 2.1 AA status messages (SC 4.1.3): non-urgent, hence polite (not assertive).

/** Stable id of the singleton shared live region, so repeat announcements reuse the same node. */
export const LIVE_REGION_ID = 'koi-live-region';

/** The ambient document, or undefined where there's no DOM (SSR / no-DOM) so callers degrade to a no-op. */
function ambientDocument(): Document | undefined {
  return typeof document !== 'undefined' ? document : undefined;
}

/**
 * Find the shared live region, creating it once (visually-hidden, polite, atomic) and appending it to
 * the document on first use. Idempotent: a region matching {@link LIVE_REGION_ID} is reused, never duplicated.
 */
function ensureRegion(doc: Document): HTMLElement {
  const existing = doc.getElementById(LIVE_REGION_ID);
  if (existing) return existing;

  const region = doc.createElement('div');
  region.id = LIVE_REGION_ID;
  region.className = 'koi-sr-only'; // visually hidden but exposed to assistive tech (see styles/base/_a11y.scss)
  region.setAttribute('aria-live', 'polite');
  region.setAttribute('aria-atomic', 'true');
  (doc.body ?? doc.documentElement).appendChild(region);
  return region;
}

/**
 * Announce `message` politely to assistive tech via the shared visually-hidden live region, lazily
 * creating that region on first use and reusing it thereafter. Last-wins: a subsequent call replaces the
 * text, so a rapid show/hide settles on the latest message rather than queuing.
 *
 * No-op when there's no document — pass `null` to force the no-op (tests/SSR); omit `doc` to use the
 * ambient document, which is itself absent under SSR.
 */
export function announce(message: string, doc: Document | null | undefined = ambientDocument()): void {
  if (!doc) return; // SSR / no-DOM — nothing to announce into
  ensureRegion(doc).textContent = message;
}
