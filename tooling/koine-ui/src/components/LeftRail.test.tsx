// Tests for LeftRail — a left rail's inner markup. The rail is a Domain·Files axis switch over one
// navigator host. This pins the shape a consuming host renders + queries, so a drift here fails fast.
// Moved from Koine Studio's `src/shell/LeftRail.test.tsx` (issue #905, Task 4).
import { afterEach, describe, it, expect } from 'vitest';
import { render } from 'preact';
import { axe } from 'vitest-axe';
import { LeftRail } from './LeftRail';

afterEach(() => {
  document.body.innerHTML = '';
});

/** Render LeftRail into its real #leftrail host (as a consuming app's index.html + boot do). */
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
    expect(document.querySelector('#rail-docs-body')).toBeNull();
  });

  it('has a collapse control and an icon spine with expand + Domain/Files toggles', () => {
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

  it('preserves the imperative-child host ids a consuming controller mounts into (#filetree-body, #rail-domain-pane)', () => {
    mountRail();
    // A Domain navigator + file explorer mount into these (empty) hosts after boot — the migration must
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
