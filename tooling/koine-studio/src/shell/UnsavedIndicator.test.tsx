import { afterEach, describe, expect, test, vi } from 'vitest';
import { act, render } from '@testing-library/preact';
import { createAppStore } from '@/store/index';
import { UnsavedIndicator } from '@/shell/UnsavedIndicator';
import type { Buffer } from '@/shell/workspaceController';
import { axe } from 'vitest-axe';

// Build the real Buffer (uri, path, relPath, name, text, dirty, rootToken).
const buf = (uri: string, dirty: boolean): Buffer => ({
  uri,
  path: uri,
  relPath: uri,
  name: uri,
  text: '',
  dirty,
  rootToken: '',
});

// Seed the whole store-owned buffer Map (#982): the slice keys buffers by uri, so build the Map from
// each buffer's own uri and set it wholesale (the ownership-inversion equivalent of the old setBuffers).
const seed = (...bufs: Buffer[]): Map<string, Buffer> => new Map(bufs.map((b) => [b.uri, b]));

// The static index.html host the indicator drives: a <button id="unsaved-indicator" hidden>.
function host(): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.id = 'unsaved-indicator';
  b.className = 'unsaved-indicator';
  b.hidden = true;
  document.body.append(b);
  return b;
}

afterEach(() => {
  document.body.innerHTML = '';
  document.title = '';
});

describe('UnsavedIndicator', () => {
  test('shows the "N unsaved" pill for the dirty buffers and hides when all clean', () => {
    const button = host();
    const store = createAppStore();
    document.title = 'Koine Studio';

    act(() => {
      render(<UnsavedIndicator store={store} host={button} baseTitle="Koine Studio" onSaveAll={() => {}} />);
    });

    // No dirty buffers yet: the pill is hidden and the title is unmarked.
    expect(button.hidden).toBe(true);
    expect(button.textContent).toBe('');
    expect(document.title).toBe('Koine Studio');

    // Two dirty buffers (plus a clean one): the pill shows "2 unsaved" and the title gains a bullet.
    act(() => store.setState({ buffers: seed(buf('a', true), buf('b', true), buf('c', false)) }));
    expect(button.hidden).toBe(false);
    expect(button.textContent).toBe('2 unsaved');
    expect(button.getAttribute('aria-label')).toBe('Save 2 unsaved files');
    expect(document.title).toBe('• Koine Studio');

    // A single dirty buffer uses the singular aria-label.
    act(() => store.setState({ buffers: seed(buf('a', true), buf('b', false)) }));
    expect(button.textContent).toBe('1 unsaved');
    expect(button.getAttribute('aria-label')).toBe('Save 1 unsaved file');

    // Everything clean again: the pill hides and the title is unmarked.
    act(() => store.setState({ buffers: seed(buf('a', false), buf('b', false)) }));
    expect(button.hidden).toBe(true);
    expect(button.textContent).toBe('');
    expect(document.title).toBe('Koine Studio');
  });

  test('clicking the pill calls onSaveAll', () => {
    const button = host();
    const store = createAppStore();
    const onSaveAll = vi.fn();

    act(() => {
      render(<UnsavedIndicator store={store} host={button} baseTitle="Koine Studio" onSaveAll={onSaveAll} />);
      store.setState({ buffers: seed(buf('a', true)) });
    });

    button.click();
    expect(onSaveAll).toHaveBeenCalledTimes(1);
  });

  test('has no accessibility violations', async () => {
    const button = host();
    const store = createAppStore();
    act(() => {
      render(<UnsavedIndicator store={store} host={button} baseTitle="Koine Studio" onSaveAll={() => {}} />);
      store.setState({ buffers: seed(buf('a', true), buf('b', true)) });
    });
    expect(await axe(button)).toHaveNoViolations();
  });

  test('keeps a baseline aria-label even with no unsaved buffers (so the button is never label-less)', () => {
    const button = host();
    const store = createAppStore();

    // Mount with zero dirty buffers: the pill is hidden, but the host button must still carry a
    // non-empty baseline aria-label. axe (storybook's a11y addon on macOS CI, #747) can otherwise race
    // the transient window where the static button is visible but the effect hasn't labelled it yet and
    // flag `button-name`; a baseline label means the button is never label-less.
    act(() => {
      render(<UnsavedIndicator store={store} host={button} baseTitle="Koine Studio" onSaveAll={() => {}} />);
    });

    expect(button.hidden).toBe(true);
    expect(button.getAttribute('aria-label')).toBe('Unsaved changes');
  });
});
