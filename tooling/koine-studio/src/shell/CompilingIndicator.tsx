import { useEffect, useRef, useState } from 'preact/hooks';
import { isCompileInFlight, onCompileActivityChange } from '@/host/browser/compileActivity';

// The transient "compiling…" status-bar indicator (#516). It surfaces the existing compile-in-flight
// signal (#469: `isCompileInFlight()`, driven by the worker transport bracketing DiagnoseWorkspace /
// EmitPreview / RunScenario) so a slow compile no longer reads as an idle editor — matching the docs-site
// playground, whose toolbar shows a busy state. The producer side is untouched; this is a read-only
// consumer of the `onCompileActivityChange` subscribe/notify seam on `compileActivity.ts`.
//
// The reveal is DEBOUNCED (~150 ms): a fast keystroke-diagnose finishes inside the window and never
// flashes the indicator on and off, matching the playground's perceived behavior. The hide is immediate.
//
// Accessibility mirrors the project-wizard announcer (src/export/generateProjectWizard.ts): the VISUAL
// pulsing pill is shown/hidden freely (and `aria-hidden`, so it isn't double-read), while announcements
// ride a SEPARATE, always-present visually-hidden `aria-live="polite"` region whose text alone toggles.
// Toggling a node's `hidden`/`display` in the same update that inserts its text is unreliable for screen
// readers — the live region must already be in the accessibility tree when its text changes — so the
// announcer stays mounted and only its text content flips between "" and "compiling…". On teardown the
// subscription is released and the pending timer cleared, so there's no leak and no setState after unmount.

const DEFAULT_DEBOUNCE_MS = 150;

export function CompilingIndicator(props: { debounceMs?: number } = {}) {
  const debounceMs = props.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const [visible, setVisible] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const clearTimer = (): void => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
    // Reconcile the indicator with the live compile-in-flight count on every idle↔busy transition
    // (and once at mount, in case a compile is already running). Reading `isCompileInFlight()` keeps
    // this correct regardless of how many nested compiles are outstanding.
    const sync = (): void => {
      if (isCompileInFlight()) {
        // idle → busy: arm the debounce. Only the reveal waits; if a timer is already armed, leave it.
        if (timerRef.current === null) {
          timerRef.current = setTimeout(() => {
            timerRef.current = null;
            if (isCompileInFlight()) setVisible(true);
          }, debounceMs);
        }
      } else {
        // busy → idle: cancel any pending reveal and hide immediately.
        clearTimer();
        setVisible(false);
      }
    };
    const unsubscribe = onCompileActivityChange(sync);
    sync();
    return () => {
      unsubscribe();
      clearTimer();
    };
  }, [debounceMs]);

  return (
    <>
      {/* The visual pulsing pill, shown only while busy. `aria-hidden` so the persistent live region
          below is the single announcement source (no double read). */}
      <span
        class="sb-item koi-compiling-indicator"
        data-role="compiling"
        aria-hidden="true"
        hidden={!visible}
      >
        {visible ? 'compiling…' : ''}
      </span>
      {/* The always-present visually-hidden polite announcer; only its text toggles, so a screen reader
          reliably announces "compiling…" when it appears and falls silent when it clears. */}
      <span class="koi-sr-only" data-role="compiling-status" aria-live="polite" aria-atomic="true">
        {visible ? 'compiling…' : ''}
      </span>
    </>
  );
}
