// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { createAboutPanel } from '@/settings/about';

const flush = () => new Promise((r) => setTimeout(r, 0));

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
    await flush();
    expect(chip.hidden).toBe(false);
    expect(chip.textContent).toMatch(/^v/); // e.g. "v0.0.0" in the test build
  });
});
