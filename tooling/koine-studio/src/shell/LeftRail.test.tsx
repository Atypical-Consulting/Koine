// Tests for the LeftRail component — the left rail's inner markup (#759, was the #453 leftRailMarkup
// string builder). The rail is a Domain·Files axis switch over one navigator host; the former
// Files/Explorer/Overview/Documentation section stack (and the docs footer) is gone. This pins the shape
// the controller and ide.tsx boot render + query, so a drift here fails fast.
import { afterEach, describe, it, expect } from 'vitest';
import { render } from 'preact';
import { axe } from 'vitest-axe';
import { LeftRail } from '@/shell/LeftRail';

afterEach(() => {
  document.body.innerHTML = '';
});

/** Render LeftRail into its real #leftrail host (as index.html + the boot do). */
function mountRail(): HTMLElement {
  document.body.innerHTML = `<aside id="leftrail" class="pane" aria-label="Workspace"></aside>`;
  const host = document.getElementById('leftrail')!;
  render(<LeftRail />, host);
  return host;
}

describe('LeftRail', () => {
  it('rail has a Domain·Files switch, no Explorer/Overview, and no docs footer', () => {
    mountRail();
    const axes = [...document.querySelectorAll('#rail-axis-switch [data-axis]')].map((b) => b.textContent);
    expect(axes).toEqual(['Domain', 'Files']);
    expect(document.body.textContent).not.toMatch(/Explorer|Overview/);
    // The docs footer (ADR/Notes) was retired (#730): those prose surfaces are reached through the
    // center Deck's Docs surface, so the rail no longer doubles as a docs doorway.
    expect(document.querySelector('#rail-docs-body')).toBeNull();
  });

  it('has a collapse control and an icon spine with expand + Domain/Files toggles (#730)', () => {
    mountRail();
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

  it('preserves the imperative-child host ids the controller mounts into (#filetree-body, #rail-domain-pane)', () => {
    mountRail();
    // The Domain navigator + file explorer mount into these (empty) hosts after boot — the migration must
    // keep them present and empty, so the imperative islands have somewhere to land.
    const domainPane = document.querySelector('#rail-domain-pane')!;
    const fileBody = document.querySelector('#filetree-body')!;
    expect(domainPane).not.toBeNull();
    expect(domainPane.childElementCount).toBe(0);
    expect(fileBody).not.toBeNull();
    expect(fileBody.childElementCount).toBe(0);
    // The Files axis pane starts hidden (the Domain-axis default state).
    expect((document.querySelector('#rail-files') as HTMLElement).hidden).toBe(true);
  });

  it('has no axe violations', async () => {
    const host = mountRail();
    expect(await axe(host)).toHaveNoViolations();
  });
});
