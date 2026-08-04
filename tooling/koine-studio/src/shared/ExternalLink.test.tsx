import { describe, expect, test, vi } from 'vitest';
import { render } from '@testing-library/preact';
import { ExternalLink } from '@/shared/ExternalLink';

// Pins the contract the component was hoisted out of Home.tsx to share (#1926): the anchor stays a REAL
// external link — `href`/`target`/`rel` intact, so copy-link, middle-click and assistive tech all still
// work — while the plain left-click is intercepted and handed to `platform.openExternal`, which opens
// the system browser instead of navigating the app's webview away from itself.
describe('ExternalLink', () => {
  const HREF = 'https://example.test/docs';

  test('renders a real external anchor carrying the class, title and children', () => {
    const { container } = render(
      <ExternalLink class="koi-x" href={HREF} title="Docs site" platform={{ openExternal: vi.fn() }}>
        Docs
      </ExternalLink>,
    );

    const a = container.querySelector('a');
    expect(a?.getAttribute('href')).toBe(HREF);
    expect(a?.getAttribute('target')).toBe('_blank');
    expect(a?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(a?.className).toBe('koi-x');
    expect(a?.getAttribute('title')).toBe('Docs site');
    expect(a?.textContent).toBe('Docs');
  });

  test('routes a left-click through platform.openExternal and suppresses the navigation', () => {
    const openExternal = vi.fn();
    const { container } = render(
      <ExternalLink class="koi-x" href={HREF} platform={{ openExternal }}>
        Docs
      </ExternalLink>,
    );

    const click = new MouseEvent('click', { cancelable: true, bubbles: true });
    container.querySelector('a')?.dispatchEvent(click);

    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenCalledWith(HREF);
    expect(click.defaultPrevented).toBe(true);
  });

  // A re-render with a fresh inline `platform` object re-runs the wiring effect. Without the effect's
  // unwire cleanup the old listener survives, so one click would open the URL once PER render.
  test('does not stack listeners when the platform identity changes across renders', () => {
    const openExternal = vi.fn();
    const { container, rerender } = render(
      <ExternalLink class="koi-x" href={HREF} platform={{ openExternal }}>
        Docs
      </ExternalLink>,
    );
    rerender(
      <ExternalLink class="koi-x" href={HREF} platform={{ openExternal }}>
        Docs
      </ExternalLink>,
    );

    container.querySelector('a')?.dispatchEvent(new MouseEvent('click', { cancelable: true, bubbles: true }));

    expect(openExternal).toHaveBeenCalledTimes(1);
  });
});
