// Tests for leftRailMarkup() — the single source of truth for the left rail's inner markup (#453).
// The rail is a Domain·Files axis switch over one navigator host; the former
// Files/Explorer/Overview/Documentation section stack (and the docs footer) is gone. This pins the
// shape the controller and ide.tsx boot inject + query, so a drift here fails fast.
import { describe, it, expect } from 'vitest';
import { leftRailMarkup } from '@/shell/leftRail';

describe('leftRailMarkup', () => {
  it('rail has a Domain·Files switch, no Explorer/Overview, and no docs footer', () => {
    document.body.innerHTML = leftRailMarkup();
    const axes = [...document.querySelectorAll('#rail-axis-switch [data-axis]')].map((b) => b.textContent);
    expect(axes).toEqual(['Domain', 'Files']);
    expect(document.body.textContent).not.toMatch(/Explorer|Overview/);
    // The docs footer (ADR/Notes) was retired (#730): those prose surfaces are reached through the
    // center Deck's Docs surface, so the rail no longer doubles as a docs doorway.
    expect(document.querySelector('#rail-docs-body')).toBeNull();
  });

  it('has a collapse control and an icon spine with expand + Domain/Files toggles (#730)', () => {
    document.body.innerHTML = leftRailMarkup();
    // The head pairs the axis switch with a collapse button that tucks the rail to its spine.
    expect(document.querySelector('#rail-collapse')).not.toBeNull();
    // The collapsed-state spine carries an expand control plus one toggle per axis.
    const spine = document.querySelector('#left-strip')!;
    expect(spine).not.toBeNull();
    expect(spine.querySelector('[data-lexpand]')).not.toBeNull();
    expect([...spine.querySelectorAll('[data-laxis]')].map((b) => (b as HTMLElement).dataset.laxis)).toEqual([
      'domain',
      'files',
    ]);
  });
});
