// Tests for the RightStrip component — the right-edge tool-window stripe's buttons (#759, was the #500
// rightStripMarkup string builder). Pins the button order, their data-rview ids, and the per-button ARIA
// (which inspectorController queries + drives), plus the #730 Rules/Notes-retired regression guard, so a
// drift here fails fast.
import { afterEach, describe, it, expect } from 'vitest';
import { render } from 'preact';
import { axe } from 'vitest-axe';
import { RightStrip } from './RightStrip';

afterEach(() => {
  document.body.innerHTML = '';
});

/** Render the stripe inside its real #right-strip toolbar shell, alongside the #right panel its buttons
 *  control (as index.html + the boot do) — so `aria-controls="right"` resolves under axe. */
function mountStrip(): HTMLElement {
  document.body.innerHTML =
    `<aside id="right" aria-label="Properties"></aside>` +
    `<div id="right-strip" role="toolbar" aria-label="Tool windows" aria-orientation="vertical"></div>`;
  const host = document.getElementById('right-strip')!;
  render(<RightStrip />, host);
  return host;
}

describe('RightStrip', () => {
  it('emits one toggle button per RightView, in Properties·AI Chat·Source Control·Syntax Tree order', () => {
    mountStrip();
    const views = [...document.querySelectorAll('#right-strip [data-rview]')].map(
      (b) => (b as HTMLElement).dataset.rview,
    );
    expect(views).toEqual(['props', 'assistant', 'source-control', 'syntax-tree']);
  });

  it('exposes the Syntax Tree toggle with its accessible name and data-rview id', () => {
    mountStrip();
    const btn = document.querySelector<HTMLButtonElement>('#right-strip [data-rview="syntax-tree"]');
    expect(btn).not.toBeNull();
    expect(btn!.getAttribute('aria-label')).toBe('Syntax Tree');
    expect(btn!.getAttribute('data-tooltip')).toBe('Syntax Tree');
    expect(btn!.querySelector('svg.tb-ico')).not.toBeNull();
  });

  it('every stripe button is an accessible toggle controlling #right', () => {
    mountStrip();
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('#right-strip .rstrip-btn')];
    expect(buttons).toHaveLength(4);
    for (const b of buttons) {
      // The visible hover/focus label is a custom left-pointing tooltip driven by data-tooltip (CSS in
      // _inspector.scss), NOT the native `title` — so AT gets one name (aria-label) without a double tip.
      expect(b.getAttribute('data-tooltip')).toBeTruthy();
      expect(b.hasAttribute('title')).toBe(false);
      expect(b.getAttribute('aria-label')).toBeTruthy();
      expect(b.getAttribute('aria-controls')).toBe('right');
      expect(b.getAttribute('aria-pressed')).toBe('false');
      expect(b.getAttribute('type')).toBe('button');
      // Each button carries its 16×16 line icon.
      expect(b.querySelector('svg.tb-ico')).not.toBeNull();
    }
  });

  it('has no axe violations', async () => {
    const container = mountStrip();
    expect(await axe(container)).toHaveNoViolations();
  });

  // Cosmetic parity with the PR #1140 handoff (#1154): a decorative hairline separator groups the git
  // tool-window (Source Control) apart from Properties/AI Chat. It is purely visual — aria-hidden and
  // non-interactive — so it must sit immediately before the Source Control button, carry no ARIA role in
  // the reading order, and never become a focusable tab stop. The active-state contract is untouched.
  it('renders the decorative .rstrip-sep hairline immediately before the Source Control button', () => {
    mountStrip();
    const sourceControl = document.querySelector<HTMLElement>('#right-strip [data-rview="source-control"]');
    expect(sourceControl).not.toBeNull();
    const prev = sourceControl!.previousElementSibling as HTMLElement | null;
    expect(prev).not.toBeNull();
    expect(prev!.classList.contains('rstrip-sep')).toBe(true);
  });

  it('emits the separator as an a11y-inert, non-focusable decorative node', () => {
    const host = mountStrip();
    const sep = host.querySelector<HTMLElement>('.rstrip-sep');
    expect(sep).not.toBeNull();
    // Decorative only — hidden from AT and never a tab stop or a button.
    expect(sep!.getAttribute('aria-hidden')).toBe('true');
    expect(sep!.hasAttribute('tabindex')).toBe(false);
    expect(sep!.tagName).not.toBe('BUTTON');
    // Exactly one separator: it groups the single git tool-window, it is not a per-button rule.
    expect(host.querySelectorAll('.rstrip-sep')).toHaveLength(1);
  });

  it('keeps no axe violations once the separator is present', async () => {
    const container = mountStrip();
    expect(await axe(container)).toHaveNoViolations();
  });

  // Regression guard for F6/F7 (#759): the Rules and Notes right-rail tabs were retired in #730 (a
  // selected element's invariants now surface in Properties, model Notes live in the center Deck's Docs
  // surface). The stripe must never reintroduce them, and must never ship the bare "Coming soon."
  // placeholder that exposed those unfinished surfaces to users.
  it('does not reintroduce the retired Rules or Notes views', () => {
    mountStrip();
    const views = [...document.querySelectorAll('#right-strip [data-rview]')].map(
      (b) => (b as HTMLElement).dataset.rview,
    );
    expect(views).not.toContain('rules');
    expect(views).not.toContain('notes');
  });

  it('never ships a "Coming soon" / placeholder leak in the stripe markup', () => {
    const host = mountStrip();
    const markup = host.innerHTML.toLowerCase();
    expect(markup).not.toContain('coming soon');
    expect(markup).not.toContain('placeholder');
    expect(markup).not.toContain('todo');
  });
});
