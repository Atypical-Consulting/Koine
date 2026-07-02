// Store-bound DeckBar for the app — subscribes to the deck slice and routes to its actions. The pure
// `DeckBar` component itself moved to @atypical/koine-ui (issue #905, Task 4): it no longer imports the
// app's surface registry directly, so this wrapper supplies it via the `surfaces` prop, and narrows the
// generic `string` ids DeckBar hands back to the store's `CenterView` via `isValidCenter` (DeckBar can
// only ever hand back an id it was given in `surfaces`, i.e. one of DECK_SURFACE_LIST's own ids, so the
// guard is defense-in-depth rather than an expected-false path).
import type { StoreApi } from 'zustand/vanilla';
import { useStore } from 'zustand';
import { DeckBar } from '@atypical/koine-ui';
import type { AppState } from '@/store/index';
import { isValidCenter } from '@/store/slices/uiChrome';
import { DECK_SURFACE_LIST } from '@/shell/deck/surfaces';

export function DeckBarConnected({ store }: { store: StoreApi<AppState> }) {
  const deck = useStore(store, (s) => s.deck);
  return (
    <DeckBar
      mode={deck.mode}
      primary={deck.primary}
      secondary={deck.secondary}
      surfaces={DECK_SURFACE_LIST}
      onOverview={() => store.getState().toggleOverview()}
      onFocus={(v) => {
        if (isValidCenter(v)) store.getState().focusPrimary(v);
      }}
      onOpenBeside={(v) => {
        if (isValidCenter(v)) store.getState().openBeside(v);
      }}
    />
  );
}
