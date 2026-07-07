import { describe, expect, test } from 'vitest';
import type { CenterView, DeckState } from '@/store/slices/uiChrome';
import { DEFAULT_DECK_STATE } from '@/store/slices/uiChrome';
import { applyDeckLayout, dividerLeft, rectFor } from '@/shell/deck/deckLayout';

const state = (over: Partial<DeckState>): DeckState => ({ ...DEFAULT_DECK_STATE, ...over });

describe('rectFor', () => {
  test('1-up: primary fills, others ghost', () => {
    const s = state({ primary: 'visual', secondary: null });
    const primary = rectFor('visual', s);
    expect(primary.ghost).toBe(false);
    expect(primary.w).toBeGreaterThan(90); // near-full width
    for (const id of ['technical', 'output', 'docs'] as CenterView[]) {
      expect(rectFor(id, s).ghost).toBe(true);
    }
  });

  test('2-up: primary on the left, secondary on the right (flipped=false)', () => {
    const s = state({ primary: 'technical', secondary: 'visual', ratio: 0.5, flipped: false });
    const left = rectFor('technical', s);
    const right = rectFor('visual', s);
    expect(left.ghost).toBe(false);
    expect(right.ghost).toBe(false);
    expect(left.l).toBeLessThan(right.l); // primary sits left
    // the two non-shown surfaces ghost
    expect(rectFor('output', s).ghost).toBe(true);
    expect(rectFor('docs', s).ghost).toBe(true);
  });

  test('2-up: flipped swaps the SIDES, not the selection', () => {
    const base = state({ primary: 'technical', secondary: 'visual', ratio: 0.5 });
    const unflipped = rectFor('technical', { ...base, flipped: false });
    const flipped = rectFor('technical', { ...base, flipped: true });
    expect(unflipped.l).toBeLessThan(flipped.l); // primary moved from left to right
  });

  test('overview: every surface is a non-ghost quad', () => {
    const s = state({ mode: 'overview', primary: 'visual', secondary: 'technical' });
    for (const id of ['visual', 'technical', 'output', 'docs'] as CenterView[]) {
      expect(rectFor(id, s).ghost).toBe(false);
    }
  });
});

describe('dividerLeft', () => {
  test('null in 1-up and overview, a percent in 2-up', () => {
    expect(dividerLeft(state({ secondary: null }))).toBeNull();
    expect(dividerLeft(state({ mode: 'overview', secondary: 'technical' }))).toBeNull();
    expect(dividerLeft(state({ secondary: 'technical', ratio: 0.5 }))).toBeGreaterThan(0);
  });
});

describe('applyDeckLayout', () => {
  function mountStage() {
    const stageEl = document.createElement('div');
    const cards: Record<CenterView, HTMLElement> = {
      visual: document.createElement('div'),
      technical: document.createElement('div'),
      output: document.createElement('div'),
      docs: document.createElement('div'),
    };
    for (const el of Object.values(cards)) stageEl.appendChild(el);
    document.body.appendChild(stageEl);
    return { stageEl, cards };
  }

  test('1-up: primary is selected and laid out, others are ghosts', () => {
    const { stageEl, cards } = mountStage();
    applyDeckLayout({ stageEl, cards, state: state({ primary: 'visual', secondary: null }), animate: false });
    expect(stageEl.classList.contains('is-focus')).toBe(true);
    expect(cards.visual.classList.contains('is-selected')).toBe(true);
    expect(cards.visual.classList.contains('ghost')).toBe(false);
    expect(cards.visual.style.left).toBe('0%'); // flush: the focused card fills the stage edge-to-edge
    expect(cards.technical.classList.contains('ghost')).toBe(true);
  });

  test('2-up: both panes are in-pair; only the primary is selected', () => {
    const { stageEl, cards } = mountStage();
    applyDeckLayout({
      stageEl,
      cards,
      state: state({ primary: 'technical', secondary: 'visual' }),
      animate: false,
    });
    expect(cards.technical.classList.contains('in-pair')).toBe(true);
    expect(cards.visual.classList.contains('in-pair')).toBe(true);
    expect(cards.technical.classList.contains('is-selected')).toBe(true);
    expect(cards.visual.classList.contains('is-selected')).toBe(false);
  });

  test('overview: stage gets the overview class and all cards are primary/secondary-tagged', () => {
    const { stageEl, cards } = mountStage();
    applyDeckLayout({
      stageEl,
      cards,
      state: state({ mode: 'overview', primary: 'visual', secondary: 'technical' }),
      animate: false,
    });
    expect(stageEl.classList.contains('overview')).toBe(true);
    expect(cards.visual.classList.contains('is-primary')).toBe(true);
    expect(cards.technical.classList.contains('is-secondary')).toBe(true);
    for (const el of Object.values(cards)) expect(el.classList.contains('ghost')).toBe(false);
  });

  test('positions the divider in 2-up and hides it in 1-up', () => {
    const { stageEl, cards } = mountStage();
    const dividerEl = document.createElement('div');
    stageEl.appendChild(dividerEl);
    applyDeckLayout({ stageEl, cards, state: state({ primary: 'technical', secondary: 'visual' }), animate: false, dividerEl });
    expect(dividerEl.classList.contains('show')).toBe(true);
    expect(dividerEl.style.left).not.toBe('');
    applyDeckLayout({ stageEl, cards, state: state({ primary: 'visual', secondary: null }), animate: false, dividerEl });
    expect(dividerEl.classList.contains('show')).toBe(false);
  });
});
