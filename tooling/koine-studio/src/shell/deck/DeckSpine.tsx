// Store-bound DeckSpine for the app — subscribes to the deck + facet state and routes to the store's
// actions. The pure `DeckSpine` component (concept-7 "Flush") lives in @atypical/koine-ui; it takes the
// app's Canvas/Code/Output/Docs registry via the `surfaces` prop and hands back generic `string` ids,
// which `isValidCenter` narrows to `CenterView` (defense-in-depth — the ids can only be ones we passed in).
// It replaces the old two-row DeckBar + card-head: one 36px spine that is the surface switcher AND the
// pane title/facets/close, morphing between overview / 1-up / 2-up.
import type { StoreApi } from 'zustand/vanilla';
import { useStore } from 'zustand';
import { DeckSpine } from '@atypical/koine-ui';
import type { AppState } from '@/store/index';
import { isValidCenter, type DocsView, type OutputTab, type TechView } from '@/store/slices/uiChrome';
import { DECK_SURFACE_LIST } from '@/shell/deck/surfaces';

export function DeckSpineConnected({ store }: { store: StoreApi<AppState> }) {
  const deck = useStore(store, (s) => s.deck);
  const tech = useStore(store, (s) => s.tech);
  const output = useStore(store, (s) => s.output);
  const docs = useStore(store, (s) => s.docs);

  const activeFacet = (id: string): string | null =>
    id === 'technical' ? tech : id === 'output' ? output : id === 'docs' ? docs : null;

  return (
    <DeckSpine
      mode={deck.mode}
      primary={deck.primary}
      secondary={deck.secondary}
      flipped={deck.flipped}
      ratio={deck.ratio}
      surfaces={DECK_SURFACE_LIST}
      activeFacet={activeFacet}
      onOverview={() => store.getState().toggleOverview()}
      onFocus={(v) => {
        if (isValidCenter(v)) store.getState().focusPrimary(v);
      }}
      onOpenBeside={(v) => {
        if (isValidCenter(v)) store.getState().openBeside(v);
      }}
      onSelectFacet={(id, value) => {
        const st = store.getState();
        if (id === 'technical') st.setTech(value as TechView);
        else if (id === 'output') st.setOutput(value as OutputTab);
        else if (id === 'docs') st.setDocs(value as DocsView);
      }}
      onClose={(v) => {
        if (isValidCenter(v)) store.getState().closeSurface(v);
      }}
      onSwap={() => store.getState().swapSides()}
      onSelectPane={(v) => {
        if (isValidCenter(v)) store.getState().selectPane(v);
      }}
    />
  );
}
