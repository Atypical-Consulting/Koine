// DeckSpine — the single chrome row above a deck stage (concept-7 "Flush"). It replaces the two-row
// deck-bar + per-card deck-head of Deck v2 with ONE 34px spine that morphs by mode:
//
//   • overview   → the surface tab-strip (split-buttons) + an active Overview toggle.
//   • focus 1-up → the tab-strip + the focused surface's inline facet strip + its tag + Overview.
//   • focus 2-up → two pane-headers ("half-spines") meeting at a docked ⇄ swap (whose left half is
//                  sized to `ratio` so it centers on the stage seam), plus a compact Overview at the end.
//
// Each surface tab is a SPLIT-BUTTON: the focus target plus a hover-revealed ⊞ "open beside" segment,
// two sibling buttons (never a nested interactive) so it stays accessible. Pure-props — a connected
// wrapper in the app binds it to the deck store. Controls carry `data-tip`/`data-key` for the instant
// tooltip (see tooltip.ts); the icon-only ones keep an `aria-label`.
import { IconClose, IconOverview, IconSplit, IconSwap } from './deckIcons';
import type { DeckCardSurface } from './DeckCard';

/** Focus = 1-up or 2-up live editing; overview = the 2x2 bird's-eye of every surface. */
export type DeckSpineMode = 'focus' | 'overview';

export interface DeckSpineProps {
  mode: DeckSpineMode;
  /** The selected (always-visible) surface — matches one of `surfaces[].id`. */
  primary: string;
  /** The comparison surface in a 2-up, or null for a 1-up. */
  secondary: string | null;
  /** Which side the primary sits on in a 2-up (false → left). Mirrors the stage's FLIP state. */
  flipped: boolean;
  /** The left pane's width fraction in a 2-up, so the docked swap lines up with the stage seam. */
  ratio: number;
  /** The surfaces to render, in display / keyboard (1–4) order. */
  surfaces: DeckCardSurface[];
  /** The active facet value for a surface id, or null when it has none / none active. */
  activeFacet(id: string): string | null;
  onOverview(): void;
  onFocus(id: string): void;
  onOpenBeside(id: string): void;
  onSelectFacet(id: string, value: string): void;
  onClose(id: string): void;
  onSwap(): void;
  onSelectPane(id: string): void;
}

/** Half the docked swap's width — the left half-spine is `ratio − this` so the swap centers on the seam. */
const SWAP_HALF_PX = 15;

export function DeckSpine(props: DeckSpineProps) {
  const { mode, primary, secondary, flipped, ratio, surfaces } = props;
  const byId = (id: string) => surfaces.find((s) => s.id === id);
  const numOf = (id: string) => surfaces.findIndex((s) => s.id === id) + 1;

  /** The focused surface's inline facet strip (empty surfaces render nothing). */
  const facets = (id: string) => {
    const s = byId(id);
    if (!s || s.facets.length === 0) return null;
    const active = props.activeFacet(id);
    return (
      <div class="fx-facets" style={`--sc:${s.accent}`}>
        {s.facets.map((f) => (
          <button
            key={f.value}
            type="button"
            class={'fx-facet' + (active === f.value ? ' on' : '')}
            aria-pressed={active === f.value}
            onClick={(e) => {
              e.stopPropagation();
              props.onSelectFacet(id, f.value);
            }}
          >
            {f.label}
          </button>
        ))}
      </div>
    );
  };

  /** A surface tab: the focus split-button + (in focus, for the non-focused surfaces) a hover-revealed ⊞.
   *  The tab-strip renders only in overview / 1-up (the 2-up path returns its own half-spines earlier), so
   *  the active tab is simply the primary; "open beside" is offered in focus only. */
  const tab = (s: DeckCardSurface) => {
    const on = s.id === primary;
    const showBeside = mode === 'focus' && !on;
    const n = numOf(s.id);
    const Icon = s.icon;
    return (
      <span key={s.id} class={'fx-tabwrap' + (on ? ' on' : '')} style={`--sc:${s.accent}`} data-s={s.id}>
        <button
          type="button"
          class={'fx-tab' + (on ? ' on' : '')}
          aria-pressed={on}
          data-tip={s.label}
          data-key={String(n)}
          aria-label={s.label}
          onClick={() => props.onFocus(s.id)}
        >
          <span class="ic">
            <Icon />
          </span>
          <span class="lbl">{s.label}</span>
        </button>
        {showBeside && (
          <button
            type="button"
            class="fx-beside"
            data-tip={`Open ${s.label} beside`}
            data-key={`⇧${n}`}
            aria-label={`Open ${s.label} beside`}
            tabIndex={-1}
            onClick={(e) => {
              e.stopPropagation();
              props.onOpenBeside(s.id);
            }}
          >
            <IconSplit />
          </button>
        )}
      </span>
    );
  };

  const overviewBtn = (opts: { active?: boolean; mini?: boolean } = {}) => (
    <button
      type="button"
      class={'fx-act' + (opts.active ? ' on' : '') + (opts.mini ? ' mini' : '')}
      aria-pressed={!!opts.active}
      aria-label="Overview"
      data-tip="Bird's-eye of all four surfaces"
      data-key="Esc"
      onClick={() => props.onOverview()}
    >
      <IconOverview />
      {!opts.mini && <span>Overview</span>}
    </button>
  );

  // --- 2-up: two pane-headers meeting at the docked swap -------------------------------------------
  if (mode === 'focus' && secondary) {
    const leftId = flipped ? secondary : primary;
    const rightId = flipped ? primary : secondary;

    const half = (id: string, style: string) => {
      const s = byId(id);
      if (!s) return null;
      const selected = id === primary;
      const Icon = s.icon;
      return (
        <div
          class={'fx-half' + (selected ? ' sel' : '')}
          style={`--sc:${s.accent};${style}`}
          data-s={id}
          onClick={() => props.onSelectPane(id)}
        >
          <span class="fx-hlabel">
            <Icon />
            {s.label}
          </span>
          {facets(id)}
          <span class="fx-grow" />
          <button
            type="button"
            class="fx-hclose"
            data-tip={`Close ${s.label}`}
            aria-label={`Close ${s.label}`}
            onClick={(e) => {
              e.stopPropagation();
              props.onClose(id);
            }}
          >
            <IconClose />
          </button>
        </div>
      );
    };

    return (
      <div class="fx-spine split">
        {half(leftId, `flex:0 0 calc(${ratio * 100}% - ${SWAP_HALF_PX}px)`)}
        <button type="button" class="fx-swap" data-tip="Swap sides" aria-label="Swap sides" onClick={() => props.onSwap()}>
          <IconSwap />
        </button>
        {half(rightId, 'flex:1 1 auto')}
        {overviewBtn({ mini: true })}
      </div>
    );
  }

  // --- overview / 1-up: the tab-strip + facets + Overview ------------------------------------------
  const focused = byId(primary);
  return (
    <div class="fx-spine">
      <div class="fx-strip" role="toolbar" aria-label="Center surfaces">
        {surfaces.map(tab)}
      </div>
      {mode === 'focus' && focused && focused.facets.length > 0 && (
        <>
          <span class="fx-div" />
          {facets(primary)}
        </>
      )}
      <span class="fx-grow" />
      {mode === 'focus' && focused && <span class="fx-tag">{focused.tag}</span>}
      {overviewBtn({ active: mode === 'overview' })}
    </div>
  );
}
