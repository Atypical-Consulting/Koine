// @vitest-environment happy-dom
import { afterEach, describe, it, expect } from 'vitest';
import { waitFor } from '@testing-library/preact';
import { axe } from 'vitest-axe';
import { createAboutPanel } from '@/settings/about';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('About panel', () => {
  it('renders the wordmark and the four project links in order', () => {
    const about = createAboutPanel();
    expect(about.el.classList.contains('koi-about')).toBe(true);
    expect(about.el.querySelector('.koi-about-wordmark')?.textContent).toContain('Koine');
    const labels = [...about.el.querySelectorAll('.koi-about-link-label')].map((n) => n.textContent);
    expect(labels).toEqual(['GitHub', 'Home', 'Docs', 'Blog']);
  });

  it('hides the build chip until refresh(), then fills it with the app version', async () => {
    const about = createAboutPanel();
    const chip = about.el.querySelector<HTMLElement>('.koi-about-chip')!;
    expect(chip.hidden).toBe(true); // hidden until a version resolves
    about.refresh();
    // The version fetch now runs inside a Preact `useEffect` (About.tsx), flushed asynchronously
    // (Preact's own after-paint scheduling, not a single microtask) — waitFor polls instead of guessing
    // a fixed number of ticks, the same idiom SourceControlPanel.test.tsx uses for its own async fetch.
    await waitFor(() => expect(chip.hidden).toBe(false));
    expect(chip.textContent).toMatch(/^v/); // e.g. "v0.0.0" in the test build
  });

  it('has no axe violations, before or after refresh (#991 task 4 recipe step 1)', async () => {
    const about = createAboutPanel();
    document.body.appendChild(about.el);
    expect(await axe(about.el)).toHaveNoViolations();

    const chip = about.el.querySelector<HTMLElement>('.koi-about-chip')!;
    about.refresh();
    await waitFor(() => expect(chip.hidden).toBe(false));
    expect(await axe(about.el)).toHaveNoViolations();
  });
});
