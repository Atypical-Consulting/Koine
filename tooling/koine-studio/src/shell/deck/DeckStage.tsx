// DeckStage — the deck's stage: four absolutely-positioned DeckCards, a draggable seam (with a swap
// button), and the FLIP engine that morphs between 1-up / 2-up / overview. Store-connected (drag →
// setRatio, swap → swapSides, keyboard → focus/openBeside/overview, layout effect → applyDeckLayout).
// Host-agnostic: pass real center-host elements via `surfaces`, or mock content via `mockBody`.
import { useEffect, useLayoutEffect, useRef } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import type { StoreApi } from 'zustand/vanilla';
import { useStore } from 'zustand';
import type { AppState } from '@/store/index';
import type { CenterView, DeckState, DocsView, OutputTab, TechView } from '@/store/slices/uiChrome';
import { DECK_SURFACE_LIST, DECK_SURFACE_ORDER } from '@/shell/deck/surfaces';
import { DeckCard } from '@atypical/koine-ui';
import { applyDeckLayout } from '@/shell/deck/deckLayout';

export interface DeckStageProps {
  store: StoreApi<AppState>;
  /** Real surface bodies to host (app). Omit and pass `mockBody` in Storybook. */
  surfaces?: Partial<Record<CenterView, HTMLElement>>;
  /** Mock body renderer for Storybook (used when `surfaces` is absent). */
  mockBody?(view: CenterView): ComponentChildren;
  /** Wire the global 1–4 / ⇧+1–4 / Esc shortcuts (default true; stories pass false). */
  enableKeyboard?: boolean;
  /** Called after each layout with the surfaces currently visible (lazy-load + re-measure hook). */
  onVisibleSurfacesChange?(views: CenterView[]): void;
}

/** The surfaces visible under a deck state: all four in overview, else primary (+ secondary). */
function visibleSurfaces(deck: DeckState): CenterView[] {
  if (deck.mode === 'overview') return [...DECK_SURFACE_ORDER];
  return deck.secondary ? [deck.primary, deck.secondary] : [deck.primary];
}

/** True when the event target is a place the user is typing — keep the deck shortcuts out of it. */
function isEditable(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.closest) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return !!el.closest('.cm-editor, [contenteditable="true"]');
}

export function DeckStage({ store, surfaces, mockBody, enableKeyboard = true, onVisibleSurfacesChange }: DeckStageProps) {
  const deck = useStore(store, (s) => s.deck);
  const tech = useStore(store, (s) => s.tech);
  const output = useStore(store, (s) => s.output);
  const docs = useStore(store, (s) => s.docs);

  const stageRef = useRef<HTMLDivElement | null>(null);
  const dividerRef = useRef<HTMLDivElement | null>(null);
  const cardRefs = useRef<Record<CenterView, HTMLElement | null>>({
    visual: null,
    technical: null,
    output: null,
    docs: null,
  });
  const prevDeck = useRef<DeckState | null>(null);
  const dragRatio = useRef(deck.ratio);

  // FLIP: animate on any focus/overview/swap change; reposition without animation on a ratio-only change.
  useLayoutEffect(() => {
    const stageEl = stageRef.current;
    if (!stageEl) return;
    const prev = prevDeck.current;
    const ratioOnly =
      !!prev &&
      prev.mode === deck.mode &&
      prev.primary === deck.primary &&
      prev.secondary === deck.secondary &&
      prev.flipped === deck.flipped &&
      prev.ratio !== deck.ratio;
    applyDeckLayout({
      stageEl,
      cards: cardRefs.current,
      state: deck,
      animate: prev !== null && !ratioOnly,
      dividerEl: dividerRef.current,
    });
    prevDeck.current = deck;
    onVisibleSurfacesChange?.(visibleSurfaces(deck));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deck.mode, deck.primary, deck.secondary, deck.flipped, deck.ratio]);

  // Global deck shortcuts.
  useEffect(() => {
    if (!enableKeyboard) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return; // leave app/editor modifier combos alone
      if (e.key === 'Escape') {
        if (isEditable(e.target)) return;
        // Don't hijack Esc while an overlay (dialog / palette / menu) is open — that owns Escape.
        if (document.querySelector('[role="dialog"], .koi-modal, .command-palette, .context-menu, .koi-context-menu')) return;
        store.getState().toggleOverview();
        return;
      }
      if (isEditable(e.target)) return;
      const m = /^(?:Digit|Numpad)([1-9])$/.exec(e.code);
      if (!m) return;
      const n = parseInt(m[1], 10);
      if (n < 1 || n > DECK_SURFACE_ORDER.length) return;
      e.preventDefault();
      const id = DECK_SURFACE_ORDER[n - 1];
      if (e.shiftKey) store.getState().openBeside(id);
      else store.getState().focusPrimary(id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enableKeyboard, store]);

  // Seam drag — apply geometry directly during the drag (smooth, no per-move store churn), commit on up.
  // The swap ⇄ now lives in the spine (DeckSpine), so the seam is a pure resize hairline; `.drag` thickens
  // it to the accent line for the duration of the drag.
  const onDividerPointerDown = (e: PointerEvent) => {
    const stageEl = stageRef.current;
    if (!stageEl) return;
    e.preventDefault();
    const seamEl = dividerRef.current;
    seamEl?.classList.add('drag');
    const rect = stageEl.getBoundingClientRect();
    const move = (ev: PointerEvent) => {
      const r = Math.min(0.8, Math.max(0.2, (ev.clientX - rect.left) / rect.width));
      dragRatio.current = r;
      applyDeckLayout({
        stageEl,
        cards: cardRefs.current,
        state: { ...store.getState().deck, ratio: r },
        animate: false,
        dividerEl: seamEl,
      });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      seamEl?.classList.remove('drag');
      store.getState().setRatio(dragRatio.current);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const facetFor = (id: CenterView): string | null =>
    id === 'technical' ? tech : id === 'output' ? output : id === 'docs' ? docs : null;

  const selectFacet = (id: CenterView, value: string) => {
    const st = store.getState();
    if (id === 'technical') st.setTech(value as TechView);
    else if (id === 'output') st.setOutput(value as OutputTab);
    else if (id === 'docs') st.setDocs(value as DocsView);
  };

  const activate = (id: CenterView) => {
    const st = store.getState();
    if (st.deck.mode === 'overview') st.focusPrimary(id);
    else st.selectPane(id);
  };

  return (
    <div class="deck-stage" ref={stageRef}>
      {/* The 2-up resize seam — a hairline that thickens on hover/drag. The swap ⇄ is docked in the spine. */}
      <div class="deck-seam" ref={dividerRef} onPointerDown={onDividerPointerDown} />
      {DECK_SURFACE_LIST.map((s) => {
        const inPair = deck.mode === 'focus' && !!deck.secondary && (s.id === deck.primary || s.id === deck.secondary);
        return (
          <DeckCard
            key={s.id}
            surface={s}
            activeFacet={facetFor(s.id)}
            inPair={inPair}
            isSelected={deck.primary === s.id}
            onActivate={() => activate(s.id)}
            onSelectFacet={(v) => selectFacet(s.id, v)}
            onClose={() => store.getState().closeSurface(s.id)}
            rootRef={(el) => {
              cardRefs.current[s.id] = el;
            }}
            hostEl={surfaces?.[s.id]}
          >
            {surfaces ? null : mockBody?.(s.id)}
          </DeckCard>
        );
      })}
    </div>
  );
}
