// DeckBar — the slim bar above a deck stage: an Overview toggle, the surface filmstrip, and a keyboard
// hint. Each filmstrip entry is a pill with the surface's focus button plus, for surfaces not currently
// shown, a sibling "open beside" (⊞) button (two sibling buttons — never a nested interactive — so it
// stays accessible).
//
// Moved from Koine Studio's `src/shell/deck/DeckBar.tsx` (issue #905, Task 4). The Studio original
// rendered a HARDCODED import of the app's own 4-entry surface registry
// (`DECK_SURFACE_LIST` from `src/shell/deck/surfaces.tsx`) rather than taking it as a prop — that's a
// real app→design-system dependency (Koine Studio's specific Canvas/Code/Output/Docs concept, plus the
// registry's own `CenterView` store type), so it doesn't belong in a published package. `surfaces` is a
// new, minimal, required prop that generalizes DeckBar into an actually reusable "tabbed filmstrip"
// component; Studio's `DeckBarConnected` (kept in `src/shell/deck/DeckBar.tsx`) now passes its
// `DECK_SURFACE_LIST` through explicitly. Everything else — markup, classes, behavior — is unchanged.
import { IconOverview, IconSplit } from './deckIcons';
import type { DeckCardSurface } from './DeckCard';

/** Focus = 1-up or 2-up live editing; overview = the 2x2 bird's-eye of every surface. */
export type DeckBarMode = 'focus' | 'overview';

export interface DeckBarProps {
  mode: DeckBarMode;
  /** The id of the selected (always-visible) surface — matches one of `surfaces[].id`. */
  primary: string;
  /** The id of the comparison surface in a 2-up, or null for a 1-up. */
  secondary: string | null;
  /** The surfaces to render in the filmstrip, in display order. */
  surfaces: DeckCardSurface[];
  onOverview(): void;
  onFocus(view: string): void;
  onOpenBeside(view: string): void;
}

export function DeckBar({ mode, primary, secondary, surfaces, onOverview, onFocus, onOpenBeside }: DeckBarProps) {
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
        {surfaces.map((s) => {
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
