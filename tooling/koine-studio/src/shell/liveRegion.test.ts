import { afterEach, describe, expect, it } from 'vitest';
import { announce, LIVE_REGION_ID } from '@/shell/liveRegion';

// The shared region is appended to the real happy-dom document; remove it after each case so the
// singleton-creation assertions stay isolated from one another.
afterEach(() => {
  document.getElementById(LIVE_REGION_ID)?.remove();
});

describe('liveRegion announce()', () => {
  it('creates exactly one polite, atomic, visually-hidden live region and writes the message into it', () => {
    announce('Koine Studio can be installed', document);

    const regions = document.querySelectorAll(`#${LIVE_REGION_ID}`);
    expect(regions.length).toBe(1);

    const region = regions[0] as HTMLElement;
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.getAttribute('aria-atomic')).toBe('true');
    expect(region.classList.contains('koi-sr-only')).toBe(true);
    expect(region.textContent).toBe('Koine Studio can be installed');
  });

  it('reuses the same single region on subsequent calls (last message wins)', () => {
    announce('first message', document);
    const first = document.getElementById(LIVE_REGION_ID);

    announce('second message', document);
    const second = document.getElementById(LIVE_REGION_ID);

    expect(second).toBe(first); // same node, not a duplicate
    expect(document.querySelectorAll(`#${LIVE_REGION_ID}`).length).toBe(1);
    expect(second?.textContent).toBe('second message');
  });

  it('is a no-op when there is no document (SSR / no-DOM)', () => {
    expect(() => announce('nobody listening', null)).not.toThrow();
    // Nothing was created against the real document either.
    expect(document.getElementById(LIVE_REGION_ID)).toBeNull();
  });
});
