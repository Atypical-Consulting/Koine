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
  it('emits one toggle button per RightView, in Properties·AI Chat·Rules·Notes·Source Control order', () => {
    mountStrip();
    const views = [...document.querySelectorAll('#right-strip [data-rview]')].map(
      (b) => (b as HTMLElement).dataset.rview,
    );
    expect(views).toEqual(['props', 'assistant', 'rules', 'notes', 'source-control']);
  });

  it('every stripe button is an accessible toggle controlling #right', () => {
    mountStrip();
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('#right-strip .rstrip-btn')];
    expect(buttons).toHaveLength(5);
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
});
