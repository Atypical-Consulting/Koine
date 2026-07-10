import { useEffect } from 'preact/hooks';
import type { ReadableStore } from '../host/store';

/**
 * The slice `UnsavedIndicator` needs from a host's workspace state: the number of open buffers with
 * unsaved changes. Deliberately NOT the host's buffer collection itself — how a "dirty buffer" is
 * modelled (Koine Studio's `Buffer` map on the workspace slice) is host domain state; the host's
 * adapter selector counts it down to this one primitive (see koine-studio's
 * `createUnsavedIndicatorStore` in `src/store/readableStores.ts`).
 */
export interface UnsavedIndicatorSlice {
  /** How many open buffers currently have unsaved changes. */
  dirtyCount: number;
}

/**
 * The document title for `count` unsaved files: a `• ` prefix signals unsaved work, like a native
 * editor's modified-title dot. Idempotent — never double-prefixes an already-marked base. Moved here
 * from koine-studio's `src/shell/dirty.ts` with the component (issue #1244) — this component is its
 * only consumer, so the title wording keeps a single home.
 */
export function titleWithDirty(base: string, count: number): string {
  const clean = base.replace(/^• /, '');
  return count > 0 ? `• ${clean}` : clean;
}

// The global unsaved-work indicator as a Preact panel (#193). It drives the existing static
// `#unsaved-indicator` button: the "N unsaved" pill text, its hidden state + aria-label, and the
// document title's `• ` bullet (via the pure `titleWithDirty`). The button itself stays the host page's
// element (so its id/class and the controller's `el(...)` lookups are untouched) — this component owns
// it through a direct store subscription rather than a child tree, so the imperative DOM and the
// reconciler never fight over the node, AND the pill/title update SYNCHRONOUSLY with the buffer-set
// change (Preact's batched re-render is async; the unsaved indicator must repaint in the same tick the
// edit lands, matching the old imperative refreshDirtyIndicator). The click wires Save-all.
//
// Moved from `koine-studio/src/shell/UnsavedIndicator.tsx` (issue #1244, third-tranche extraction): the
// component used to subscribe to the whole app store and count the dirty buffers itself; it now depends
// on `ReadableStore<UnsavedIndicatorSlice>` (issue #944's host-adapter contract), so counting — and the
// "only notify when the count actually changed" gate that keeps the common no-op write from repainting —
// live in the host's adapter instead.
export function UnsavedIndicator(props: {
  store: ReadableStore<UnsavedIndicatorSlice>;
  host: HTMLButtonElement;
  baseTitle: string;
  onSaveAll: () => void;
}) {
  const { store, host, baseTitle, onSaveAll } = props;

  // Wire Save-all; rebind on change and clean up so a remount never leaves a stale handler.
  useEffect(() => {
    const onClick = (): void => onSaveAll();
    host.addEventListener('click', onClick);
    return () => host.removeEventListener('click', onClick);
  }, [host, onSaveAll]);

  // Subscribe to the dirty count and drive the host button + title synchronously on every change.
  // Mirrors the exact strings the old imperative refreshDirtyIndicator produced ("N unsaved",
  // "Save N unsaved file(s)", "• <title>"). Applied once immediately, then on each store change —
  // the ReadableStore contract makes each notification a REAL change, so no last-value gate is needed.
  useEffect(() => {
    // Keep the host button labelled in BOTH states so it's never label-less. The button is the static
    // index.html element, visible before this effect first runs; storybook's a11y addon (axe) can race
    // that window on the slower macOS CI runner and flag `button-name` on the empty button (#747).
    // `apply(n>0)` sets the precise "Save N unsaved file(s)" label; `apply(0)` sets a baseline instead of
    // removing the label (the button is `hidden` then — out of the a11y tree — but keeping a label also
    // avoids a transient empty button on the n>0 → 0 transition). The first `apply` runs synchronously
    // below, so the button carries discernible text the instant this effect runs.
    const baselineLabel = 'Unsaved changes';
    const apply = (n: number): void => {
      document.title = titleWithDirty(baseTitle, n);
      if (n > 0) {
        host.textContent = `${n} unsaved`;
        host.setAttribute('aria-label', `Save ${n} unsaved file${n === 1 ? '' : 's'}`);
        host.hidden = false;
      } else {
        host.textContent = '';
        host.setAttribute('aria-label', baselineLabel);
        host.hidden = true;
      }
    };
    apply(store.getState().dirtyCount);
    return store.subscribe((s) => apply(s.dirtyCount));
  }, [store, host, baseTitle]);

  // The button lives in the host page; this component owns it via effects, so it renders no tree of its own.
  return null;
}
