// DeckCard — one surface card on a "deck" stage: a header (icon + label + hoisted facet sub-strip + tag +
// close) over a body slot. The body is host-agnostic: a real re-parented `HTMLElement` (via a ref), or
// mock `children` in Storybook/tests.
//
// Moved from Koine Studio's `src/shell/deck/DeckCard.tsx` (issue #905, Task 4). Studio's original typed
// `surface` as its own app-specific `DeckSurface` (whose `id` is the app's `CenterView` store type,
// `'visual' | 'technical' | 'output' | 'docs'`) — a published design-system package can't depend on an
// app's store types, so `DeckCardSurface` below is the generic, app-agnostic shape DeckCard actually
// needs (id widened to `string`; everything else is unchanged). Studio's own `DeckSurface` structurally
// satisfies this interface, so `DeckStage.tsx` passes its `DECK_SURFACE_LIST` entries straight through
// with no cast.
//
// IMPORTANT: the card ROOT's dynamic layout classes (ghost / in-pair / is-selected / is-primary /
// is-secondary) and its inline geometry are owned by the consumer's imperative FLIP engine (Studio's
// deckLayout.ts), NOT by Preact — this component never sets them on the root, so reconciliation can't
// fight the animation. The header's selected/pair styling cascades from those root classes via CSS.
// `inPair` / `isSelected` here drive CONTENT only (whether the close button is reachable, aria state).
import type { ComponentChildren, JSX } from 'preact';
import { IconClose } from './deckIcons';

export interface DeckCardFacet {
  value: string;
  label: string;
}

export interface DeckCardSurface {
  /** A stable identifier for this surface (rendered verbatim as `data-surface`). */
  id: string;
  label: string;
  /** Short subtitle shown in the card header (1-up / overview) and as the chip title. */
  tag: string;
  /** CSS custom-property reference (or literal color) tinting the surface's header icon. */
  accent: string;
  icon: (props: { class?: string }) => JSX.Element;
  /** The surface's facets, in display order. Empty when the surface has a single view. */
  facets: DeckCardFacet[];
}

export interface DeckCardProps {
  surface: DeckCardSurface;
  /** The surface's active facet value, or null when none. */
  activeFacet: string | null;
  /** True when this card is one of the two panes in a live 2-up (drives the reachable close button). */
  inPair: boolean;
  /** True when this card is the selected surface (the primary). Content/aria only. */
  isSelected: boolean;
  /** Root click — the parent routes it (overview → focus this surface; 2-up → select this pane). */
  onActivate(): void;
  onSelectFacet(value: string): void;
  onClose(): void;
  /** Collect the root element for the host's FLIP engine. */
  rootRef(el: HTMLElement | null): void;
  /** The real surface body to host (re-parented into the card). Omit and pass `children` instead. */
  hostEl?: HTMLElement;
  children?: ComponentChildren;
}

export function DeckCard({
  surface,
  activeFacet,
  inPair,
  isSelected,
  onActivate,
  onSelectFacet,
  onClose,
  rootRef,
  hostEl,
  children,
}: DeckCardProps) {
  const Icon = surface.icon;
  const bodyRef = (el: HTMLElement | null) => {
    if (el && hostEl && hostEl.parentElement !== el) {
      el.appendChild(hostEl);
      hostEl.hidden = false;
    }
  };
  const stop = (e: JSX.TargetedMouseEvent<HTMLElement>) => e.stopPropagation();

  return (
    <div
      class="deck-card"
      ref={rootRef}
      style={`--card-c:${surface.accent}`}
      aria-label={surface.label}
      data-surface={surface.id}
      data-selected={isSelected ? 'true' : undefined}
      onClick={() => onActivate()}
    >
      <div class="deck-head">
        <span class="ci">
          <Icon />
        </span>
        <span class="hlabel">{surface.label}</span>
        {surface.facets.length > 0 && (
          <div class="deck-subs" role="group" aria-label={`${surface.label} views`}>
            {surface.facets.map((f) => (
              <button
                key={f.value}
                type="button"
                class={'deck-sub' + (activeFacet === f.value ? ' on' : '')}
                aria-pressed={activeFacet === f.value}
                onClick={(e) => {
                  stop(e);
                  onSelectFacet(f.value);
                }}
              >
                {f.label}
              </button>
            ))}
          </div>
        )}
        <span class="grow" />
        <span class="tag">{surface.tag}</span>
        <button
          type="button"
          class="hbtn close"
          aria-label={`Close ${surface.label}`}
          title="Close"
          tabIndex={inPair ? 0 : -1}
          onClick={(e) => {
            stop(e);
            onClose();
          }}
        >
          <IconClose />
        </button>
      </div>
      <div class="deck-body" ref={bodyRef}>
        {hostEl ? null : children}
      </div>
    </div>
  );
}
