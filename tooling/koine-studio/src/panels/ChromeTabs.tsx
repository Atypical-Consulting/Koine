import { Fragment } from 'preact';
import type { StoreApi } from 'zustand/vanilla';
import { useStore } from 'zustand';
import type { AppState } from '../store/index';
import { MODES } from '../modes';

// The workspace mode switcher (Domain / Code / Docs) as a Preact panel (#193). Every button's
// `aria-selected` is derived from the `uiChrome` slice's `mode`, and each `onClick` calls `setMode` —
// which, in the slice, also re-derives `center`. Because the highlighted button AND the shown center
// view both come from the ONE slice value, the long-standing "button says X but the center shows Y"
// divergence is structurally impossible: there is no second source of truth to drift against.
//
// Scoped to the mode row. The center/tech/docs tab groups remain the static `index.html` buttons (their
// ids are read by the controller's `el(...)` lookups, e.g. the Generated tab's relabel), but their
// click handlers and `applyCenterChrome` paint now both route through the same slice, so those tabs
// share the same single-source-of-truth discipline without being re-rendered as Preact here.
export function ChromeTabs(props: { store: StoreApi<AppState> }) {
  const mode = useStore(props.store, (s) => s.mode);
  const setMode = useStore(props.store, (s) => s.setMode);
  // A Fragment (not a wrapping element): the panel mounts INTO the existing `#mode-switcher` host, which
  // is already the `.mode-switcher` `role="tablist"` nav, so the buttons are its direct children.
  return (
    <Fragment>
      {MODES.map((m) => (
        <button
          key={m.id}
          type="button"
          class="mode-btn"
          role="tab"
          data-mode={m.id}
          aria-selected={m.id === mode}
          onClick={() => setMode(m.id)}
        >
          {m.label}
        </button>
      ))}
    </Fragment>
  );
}
