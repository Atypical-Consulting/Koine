// Global dismissal for the diagram Export ▾ disclosure (#534).
//
// The Export menu in CanvasPalette is a native `<details class="koi-export">`, which only closes via its
// own `<summary>`. Closing it on item-select is handled in CanvasPalette itself; this wires the two
// remaining dismissal paths a transient menu needs:
//   1. clicking anywhere OUTSIDE the open menu closes it (a capturing document `pointerdown`), and
//   2. opening a modal / command-palette overlay closes it — so an open menu can never linger above a
//      modal scrim (the original bug, where the menu painted over the `.koi-modal-backdrop`).
// `installExportMenuDismiss` returns a teardown the IDE calls on unmount so the listeners don't leak
// across hot-reloads / test boots.

const EXPORT_OPEN_SELECTOR = 'details.koi-export[open]';
// The same overlay signal the IDE uses (see `overlayOpen()` in ide.tsx): a visible modal or
// command-palette backdrop. `[hidden]` backdrops are dormant and must not trigger a dismissal.
const OVERLAY_SELECTOR = '.koi-palette-backdrop:not([hidden]), .koi-modal-backdrop:not([hidden])';

function closeOpenExportMenus(doc: Document): void {
  doc.querySelectorAll<HTMLDetailsElement>(EXPORT_OPEN_SELECTOR).forEach((d) => d.removeAttribute('open'));
}

/**
 * Wire global Export-menu dismissal on `doc`. Returns a teardown that removes the pointerdown listener
 * and disconnects the overlay observer.
 */
export function installExportMenuDismiss(doc: Document = document): () => void {
  // (1) Outside-click. Capturing so it fires even if a child stops propagation; presses INSIDE an open
  // `.koi-export` are ignored so the summary's own toggle keeps working and selecting an item (handled
  // in CanvasPalette) isn't double-driven.
  const onPointerDown = (ev: Event) => {
    const target = ev.target as Node | null;
    doc.querySelectorAll<HTMLDetailsElement>(EXPORT_OPEN_SELECTOR).forEach((d) => {
      if (!target || !d.contains(target)) d.removeAttribute('open');
    });
  };
  doc.addEventListener('pointerdown', onPointerDown, true);

  // (2) Overlay-open. A MutationObserver covers every overlay-show path (button- or keyboard-triggered)
  // without each call site having to notify us: a backdrop being added to the DOM, or its `hidden`
  // attribute being removed, both fire here. The work is gated on an Export menu actually being open, so
  // the common no-menu case is a single cheap selector check per mutation batch.
  const observer = new MutationObserver(() => {
    if (doc.querySelector(EXPORT_OPEN_SELECTOR) && doc.querySelector(OVERLAY_SELECTOR)) {
      closeOpenExportMenus(doc);
    }
  });
  if (doc.body) {
    observer.observe(doc.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['hidden'],
    });
  }

  return () => {
    doc.removeEventListener('pointerdown', onPointerDown, true);
    observer.disconnect();
  };
}
