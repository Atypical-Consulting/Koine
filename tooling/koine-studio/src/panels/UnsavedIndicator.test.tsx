import { afterEach, describe, expect, test, vi } from 'vitest';
import { act, render } from '@testing-library/preact';
import { createAppStore } from '../store/index';
import { UnsavedIndicator } from './UnsavedIndicator';
import type { Buffer } from '../workspaceController';

// Build the real 6-field Buffer (uri, path, relPath, name, text, dirty).
const buf = (uri: string, dirty: boolean): Buffer => ({
  uri,
  path: uri,
  relPath: uri,
  name: uri,
  text: '',
  dirty,
});

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
    act(() => store.getState().setBuffers({ a: buf('a', true), b: buf('b', true), c: buf('c', false) }));
    expect(button.hidden).toBe(false);
    expect(button.textContent).toBe('2 unsaved');
    expect(button.getAttribute('aria-label')).toBe('Save 2 unsaved files');
    expect(document.title).toBe('• Koine Studio');

    // A single dirty buffer uses the singular aria-label.
    act(() => store.getState().setBuffers({ a: buf('a', true), b: buf('b', false) }));
    expect(button.textContent).toBe('1 unsaved');
    expect(button.getAttribute('aria-label')).toBe('Save 1 unsaved file');

    // Everything clean again: the pill hides and the title is unmarked.
    act(() => store.getState().setBuffers({ a: buf('a', false), b: buf('b', false) }));
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
      store.getState().setBuffers({ a: buf('a', true) });
    });

    button.click();
    expect(onSaveAll).toHaveBeenCalledTimes(1);
  });
});
