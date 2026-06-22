import { useEffect } from 'preact/hooks';
import type { StoreApi } from 'zustand/vanilla';
import type { AppState } from '../store/index';
import { titleWithDirty } from '../dirty';

// The global unsaved-work indicator as a Preact panel (#193). It drives the existing static
// `#unsaved-indicator` button: the "N unsaved" pill text, its hidden state + aria-label, and the
// document title's `• ` bullet (via the pure `titleWithDirty`). The button itself stays the index.html
// element (so its id/class and the controller's `el(...)` lookups are untouched) — this component owns
// it through a direct store subscription rather than a child tree, so the imperative DOM and the
// reconciler never fight over the node, AND the pill/title update SYNCHRONOUSLY with the buffer-set
// change (Preact's batched re-render is async; the unsaved indicator must repaint in the same tick the
// edit lands, matching the old imperative refreshDirtyIndicator). The click wires Save-all. Replaces
// ide.ts's imperative refreshDirtyIndicator DOM writes.
export function UnsavedIndicator(props: {
  store: StoreApi<AppState>;
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
  // "Save N unsaved file(s)", "• <title>"). Applied once immediately, then on each store change.
  useEffect(() => {
    const apply = (n: number): void => {
      document.title = titleWithDirty(baseTitle, n);
      if (n > 0) {
        host.textContent = `${n} unsaved`;
        host.setAttribute('aria-label', `Save ${n} unsaved file${n === 1 ? '' : 's'}`);
        host.hidden = false;
      } else {
        host.textContent = '';
        host.removeAttribute('aria-label');
        host.hidden = true;
      }
    };
    const countOf = (b: AppState['buffers']): number => Object.values(b).filter((x) => x.dirty).length;
    let last = countOf(store.getState().buffers);
    apply(last);
    // The slice methods close over the store's live `get`, so `prev.dirtyCount()` would read the
    // CURRENT buffers — compute from each snapshot's own `buffers` map instead, and only repaint when
    // the dirty total actually changed (the common no-op render skips the title/DOM writes).
    return store.subscribe((s) => {
      const n = countOf(s.buffers);
      if (n !== last) {
        last = n;
        apply(n);
      }
    });
  }, [store, host, baseTitle]);

  // The button lives in index.html; this component owns it via effects, so it renders no tree of its own.
  return null;
}
