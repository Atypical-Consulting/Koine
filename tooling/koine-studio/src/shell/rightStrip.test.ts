// Tests for rightStripMarkup() — the single source of truth for the right-edge tool-window stripe's
// buttons (mirrors the leftRail #453 pattern: index.html holds a thin <aside id="right-strip"> shell,
// the builder is the testable markup the boot injects + the controller queries). Pins the button order,
// their data-rview ids, and the per-button ARIA, so a drift here fails fast.
import { describe, it, expect } from 'vitest';
import { axe } from 'vitest-axe';
import { rightStripMarkup } from '@/shell/rightStrip';

/** Build the stripe inside its real #right-strip toolbar shell, alongside the #right panel its buttons
 *  control (as index.html + the boot do) — so `aria-controls="right"` resolves under axe. */
function mountStrip(): HTMLElement {
  document.body.innerHTML =
    `<aside id="right" aria-label="Properties"></aside>` +
    `<div id="right-strip" role="toolbar" aria-label="Tool windows" aria-orientation="vertical">${rightStripMarkup()}</div>`;
  return document.getElementById('right-strip')!;
}

describe('rightStripMarkup', () => {
  it('emits one toggle button per RightView, in Properties·AI Chat·Source Control order', () => {
    mountStrip();
    const views = [...document.querySelectorAll('#right-strip [data-rview]')].map(
      (b) => (b as HTMLElement).dataset.rview,
    );
    expect(views).toEqual(['props', 'assistant', 'source-control']);
  });

  it('every stripe button is an accessible toggle controlling #right', () => {
    mountStrip();
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('#right-strip .rstrip-btn')];
    expect(buttons).toHaveLength(3);
    for (const b of buttons) {
      // The visible hover/focus label is a custom left-pointing tooltip driven by data-tooltip (CSS in
      // _inspector.scss), NOT the native `title` — so AT gets one name (aria-label) without a double tip.
      expect(b.getAttribute('data-tooltip')).toBeTruthy();
      expect(b.hasAttribute('title')).toBe(false);
      expect(b.getAttribute('aria-label')).toBeTruthy();
      expect(b.getAttribute('aria-controls')).toBe('right');
      expect(b.getAttribute('aria-pressed')).toBe('false');
      expect(b.getAttribute('type')).toBe('button');
    }
  });

  it('has no axe violations', async () => {
    const container = mountStrip();
    expect(await axe(container)).toHaveNoViolations();
  });

  // Regression guard for F6/F7 (#759): the Rules and Notes right-rail tabs were retired in #730 (a
  // selected element's invariants now surface in Properties, model Notes live in the center Deck's Docs
  // surface). The stripe must never reintroduce them, and must never ship the bare "Coming soon."
  // placeholder that exposed those unfinished surfaces to users. panelGate (src/shell/panelGate.ts) is
  // the mechanism for hiding any *future* incomplete surface; this guard locks the resolved state.
  it('does not reintroduce the retired Rules or Notes views', () => {
    mountStrip();
    const views = [...document.querySelectorAll('#right-strip [data-rview]')].map(
      (b) => (b as HTMLElement).dataset.rview,
    );
    expect(views).not.toContain('rules');
    expect(views).not.toContain('notes');
  });

  it('never ships a "Coming soon" / placeholder leak in the stripe markup', () => {
    const markup = rightStripMarkup().toLowerCase();
    expect(markup).not.toContain('coming soon');
    expect(markup).not.toContain('placeholder');
    expect(markup).not.toContain('todo');
  });
});
