// DeckBar — the slim bar above the deck stage: an Overview toggle, the surface filmstrip, and a
// keyboard hint. Each filmstrip entry is a pill with the surface's focus button plus, for surfaces
// not currently shown, a sibling "open beside" (⊞) button (two sibling buttons — never a nested
// interactive — so it stays accessible). Pure-props for easy stories; `DeckBarConnected` binds it to
// the store for the app.
import type { StoreApi } from 'zustand/vanilla';
import { useStore } from 'zustand';
import type { AppState } from '@/store/index';
import type { CenterView, DeckMode } from '@/store/slices/uiChrome';
import { DECK_SURFACE_LIST, IconOverview, IconSplit } from '@/shell/deck/surfaces';

export interface DeckBarProps {
  mode: DeckMode;
  primary: CenterView;
  secondary: CenterView | null;
  onOverview(): void;
  onFocus(view: CenterView): void;
  onOpenBeside(view: CenterView): void;
}

export function DeckBar({ mode, primary, secondary, onOverview, onFocus, onOpenBeside }: DeckBarProps) {
  return (
    <div class="deck-bar">
      <button
        type="button"
        class={'deck-over' + (mode === 'overview' ? ' on' : '')}
        aria-pressed={mode === 'overview'}
        title="Bird's-eye of all four surfaces"
        onClick={() => onOverview()}
      >
        <IconOverview />
        <span>Overview</span>
      </button>
      <div class="deck-strip" role="toolbar" aria-label="Center surfaces">
        {DECK_SURFACE_LIST.map((s) => {
          const Icon = s.icon;
          const isP = s.id === primary;
          const isS = s.id === secondary;
          const shown = isP || isS;
          const showCmp = mode === 'focus' && !shown;
          return (
            <div key={s.id} class={'deck-chip-wrap' + (isP ? ' primary' : '') + (isS ? ' secondary' : '')}>
              <button
                type="button"
                class="deck-chip"
                aria-pressed={shown}
                title={s.tag}
                onClick={() => onFocus(s.id)}
              >
                <span class="ci-wrap">
                  <Icon class="ci" />
                </span>
                <span class="chip-label">{s.label}</span>
              </button>
              {showCmp && (
                <button
                  type="button"
                  class="deck-cmp"
                  aria-label={`Open ${s.label} beside`}
                  title="Open beside"
                  tabIndex={-1}
                  onClick={() => onOpenBeside(s.id)}
                >
                  <IconSplit class="cmp-ico" />
                </button>
              )}
            </div>
          );
        })}
      </div>
      <div class="deck-hint" aria-hidden="true">
        <kbd>Esc</kbd> overview · <kbd>1</kbd>–<kbd>4</kbd> focus · <kbd>⇧</kbd>+<kbd>1</kbd>–<kbd>4</kbd> beside
      </div>
    </div>
  );
}

/** Store-bound DeckBar for the app — subscribes to the deck slice and routes to its actions. */
export function DeckBarConnected({ store }: { store: StoreApi<AppState> }) {
  const deck = useStore(store, (s) => s.deck);
  return (
    <DeckBar
      mode={deck.mode}
      primary={deck.primary}
      secondary={deck.secondary}
      onOverview={() => store.getState().toggleOverview()}
      onFocus={(v) => store.getState().focusPrimary(v)}
      onOpenBeside={(v) => store.getState().openBeside(v)}
    />
  );
}
