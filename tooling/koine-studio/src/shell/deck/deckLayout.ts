// deckLayout — the FLIP engine for the Deck v2 center stage. A faithful port of the POC's
// `apply(animate)` + `rectFor(id)`. The four surface cards are absolutely positioned in the stage;
// this module writes each card's FINAL geometry (% box) and state classes instantly, then — when
// animating — INVERTS with a transform and PLAYS to identity so only `transform` animates (a
// compositor-only zoom; the editor/diagram lay out once at final size rather than reflowing each
// frame). `prefers-reduced-motion` is honoured by the CSS (`.deck-card { transition: none !important }`),
// which overrides the inline transition set here, so the morph simply snaps.
import type { CenterView, DeckState } from '@/store/slices/uiChrome';
import { DECK_SURFACE_ORDER } from '@/shell/deck/surfaces';

interface Rect {
  l: number;
  t: number;
  w: number;
  h: number;
  ghost: boolean;
}

// Geometry in stage-percent units. Concept-7 "Flush": in focus the surface fills the stage edge-to-edge
// (no inset) — FULL/U span the whole stage — and only a thin seam channel (GAP) separates a 2-up pair.
// The floating-card inset lives only in overview (QUAD, below).
const FULL = { l: 0, t: 0, w: 100, h: 100 };
const U = { x: 0, w: 100 }; // usable strip for the 2-up split (full-bleed)
const GAP = 0.6; // the 2-up seam channel (a thin gutter the hairline divider sits in)
const QUAD: Record<CenterView, { l: number; t: number; w: number; h: number }> = {
  visual: { l: 1.6, t: 2, w: 47.6, h: 46 },
  technical: { l: 50.8, t: 2, w: 47.6, h: 46 },
  output: { l: 1.6, t: 50, w: 47.6, h: 46 },
  docs: { l: 50.8, t: 50, w: 47.6, h: 46 },
};

/** The target rect (percent box) for a surface under the given deck state. */
export function rectFor(id: CenterView, state: DeckState): Rect {
  const { mode, primary, secondary, ratio, flipped } = state;
  if (mode === 'overview') return { ...QUAD[id], ghost: false };
  if (!secondary) return id === primary ? { ...FULL, ghost: false } : { ...QUAD[id], ghost: true };
  // 2-up: left/right are POSITIONS; `flipped` decides which surface sits where.
  const leftRect: Rect = { l: U.x, t: 0, w: ratio * U.w - GAP / 2, h: 100, ghost: false };
  const seam = U.x + ratio * U.w;
  const rightRect: Rect = { l: seam + GAP / 2, t: 0, w: (1 - ratio) * U.w - GAP / 2, h: 100, ghost: false };
  const primaryLeft = !flipped;
  if (id === primary) return primaryLeft ? leftRect : rightRect;
  if (id === secondary) return primaryLeft ? rightRect : leftRect;
  return { ...QUAD[id], ghost: true };
}

/** The 2-up seam position (left%) for the divider, or null in 1-up / overview. */
export function dividerLeft(state: DeckState): number | null {
  if (state.mode !== 'focus' || !state.secondary) return null;
  return U.x + state.ratio * U.w;
}

export interface ApplyDeckOptions {
  stageEl: HTMLElement;
  cards: Partial<Record<CenterView, HTMLElement | null>>;
  state: DeckState;
  animate: boolean;
  dividerEl?: HTMLElement | null;
}

/** Apply the deck layout to the stage: write each card's final geometry + classes, run the FLIP when
 *  animating, and position the divider. Mirrors the POC `apply(animate)`. */
export function applyDeckLayout({ stageEl, cards, state, animate, dividerEl }: ApplyDeckOptions): void {
  const order = DECK_SURFACE_ORDER;
  const entries = order.map((id) => [id, cards[id]] as const).filter((e): e is [CenterView, HTMLElement] => !!e[1]);

  // FIRST — capture current rects (skipped when not animating).
  const first = animate ? new Map(entries.map(([id, el]) => [id, el.getBoundingClientRect()])) : null;

  // LAST — write target geometry + state classes instantly.
  for (const [id, el] of entries) {
    const r = rectFor(id, state);
    el.style.left = `${r.l}%`;
    el.style.top = `${r.t}%`;
    el.style.width = `${r.w}%`;
    el.style.height = `${r.h}%`;
    el.classList.toggle('ghost', r.ghost);
    el.classList.toggle('is-primary', state.mode === 'overview' && id === state.primary);
    el.classList.toggle('is-secondary', state.mode === 'overview' && id === state.secondary);
    el.classList.toggle('in-pair', state.mode === 'focus' && !!state.secondary && (id === state.primary || id === state.secondary));
    el.classList.toggle('is-selected', state.mode === 'focus' && id === state.primary);
    el.style.transition = 'none';
  }
  stageEl.classList.toggle('overview', state.mode === 'overview');
  stageEl.classList.toggle('is-focus', state.mode === 'focus');

  // INVERT + PLAY.
  if (animate && first) {
    for (const [id, el] of entries) {
      const f = first.get(id);
      const l = el.getBoundingClientRect();
      if (!f || !f.width || !l.width) continue;
      const dx = f.left - l.left;
      const dy = f.top - l.top;
      const sx = f.width / l.width;
      const sy = f.height / l.height;
      el.style.transform = `translate(${dx}px,${dy}px) scale(${sx},${sy})`;
    }
    // Force a reflow so the inverted transforms are committed before the PLAY.
    void stageEl.offsetHeight;
    entries.forEach(([, el], i) => {
      el.style.transition =
        'transform .44s cubic-bezier(.22,1,.36,1), opacity .32s ease, box-shadow .3s ease';
      el.style.transitionDelay = `${state.mode === 'overview' ? i * 22 : 0}ms`;
      el.style.transform = '';
    });
  } else {
    for (const [, el] of entries) el.style.transform = '';
  }

  // Divider (2-up only).
  if (dividerEl) {
    const left = dividerLeft(state);
    dividerEl.classList.toggle('show', left !== null);
    if (left !== null) dividerEl.style.left = `${left}%`;
  }
}
