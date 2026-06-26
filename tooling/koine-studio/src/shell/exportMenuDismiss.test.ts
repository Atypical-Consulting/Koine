import { describe, expect, test, afterEach } from 'vitest';
import { waitFor } from '@testing-library/preact';
import { installExportMenuDismiss } from '@/shell/exportMenuDismiss';

// Build an open Export disclosure (`<details class="koi-export" open>`) on document.body, mirroring the
// CanvasPalette markup closely enough for the global dismissal wiring (#534).
function mountOpenExport(): HTMLDetailsElement {
  const details = document.createElement('details');
  details.className = 'koi-export';
  details.setAttribute('open', '');
  const summary = document.createElement('summary');
  const item = document.createElement('button');
  item.className = 'koi-export-item';
  details.append(summary, item);
  document.body.appendChild(details);
  return details;
}

describe('installExportMenuDismiss (#534)', () => {
  let teardown: (() => void) | null = null;

  afterEach(() => {
    teardown?.();
    teardown = null;
    document.body.innerHTML = '';
  });

  test('a document pointerdown OUTSIDE the open menu dismisses it', () => {
    const details = mountOpenExport();
    teardown = installExportMenuDismiss(document);
    const outside = document.createElement('div');
    document.body.appendChild(outside);
    outside.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(details.hasAttribute('open')).toBe(false);
  });

  test('a pointerdown INSIDE the menu leaves it open (the summary toggle still works)', () => {
    const details = mountOpenExport();
    teardown = installExportMenuDismiss(document);
    const item = details.querySelector('.koi-export-item') as HTMLElement;
    item.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(details.hasAttribute('open')).toBe(true);
  });

  test('showing a modal backdrop dismisses the open menu so it never sits above the scrim', async () => {
    const details = mountOpenExport();
    teardown = installExportMenuDismiss(document);
    const backdrop = document.createElement('div');
    backdrop.className = 'koi-modal-backdrop';
    document.body.appendChild(backdrop);
    await waitFor(() => expect(details.hasAttribute('open')).toBe(false));
  });

  test('un-hiding an existing command-palette backdrop dismisses the open menu', async () => {
    const backdrop = document.createElement('div');
    backdrop.className = 'koi-palette-backdrop';
    backdrop.setAttribute('hidden', '');
    document.body.appendChild(backdrop);
    const details = mountOpenExport();
    teardown = installExportMenuDismiss(document);
    backdrop.removeAttribute('hidden');
    await waitFor(() => expect(details.hasAttribute('open')).toBe(false));
  });

  test('teardown removes the listeners (no dismissal after unmount)', () => {
    const details = mountOpenExport();
    const t = installExportMenuDismiss(document);
    t();
    const outside = document.createElement('div');
    document.body.appendChild(outside);
    outside.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(details.hasAttribute('open')).toBe(true);
  });
});
