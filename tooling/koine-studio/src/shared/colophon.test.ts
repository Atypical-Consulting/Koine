// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import type { Platform } from '@/host';
import {
  PROJECT_LINKS,
  CREATOR_NAME,
  CREDIT_PREFIX,
  fillVersionChip,
} from '@/shared/colophon';

const flush = () => new Promise((r) => setTimeout(r, 0));

/** A minimal Platform stub exposing only the version method `fillVersionChip` reads. */
function platformWithVersion(impl: () => Promise<string>): Platform {
  return { appVersion: impl } as unknown as Platform;
}

describe('colophon content', () => {
  it('lists the four project links in on-screen order, each an https URL', () => {
    expect(PROJECT_LINKS.map((l) => l.label)).toEqual(['GitHub', 'Home', 'Docs', 'Blog']);
    expect(PROJECT_LINKS.every((l) => l.href.startsWith('https://'))).toBe(true);
  });

  it('names the creator and ends the credit prefix at the byline insertion point', () => {
    expect(CREATOR_NAME).toBe('Philippe Matray');
    expect(CREDIT_PREFIX.endsWith('built by ')).toBe(true);
  });
});

describe('fillVersionChip', () => {
  it('fills the chip with v<version> and unhides it when appVersion resolves', async () => {
    const chip = document.createElement('span');
    chip.hidden = true;
    fillVersionChip(chip, platformWithVersion(() => Promise.resolve('9.9.9')));
    await flush();
    expect(chip.textContent).toBe('v9.9.9');
    expect(chip.hidden).toBe(false);
  });

  it('leaves the chip hidden when appVersion rejects', async () => {
    const chip = document.createElement('span');
    chip.hidden = true;
    fillVersionChip(chip, platformWithVersion(() => Promise.reject(new Error('no version'))));
    await flush();
    expect(chip.hidden).toBe(true);
  });
});
