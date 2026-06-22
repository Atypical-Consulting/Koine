import { describe, expect, test } from 'vitest';
import { act, render } from '@testing-library/preact';
import { createAppStore } from '../store/index';
import { MODES } from '../modes';
import { ChromeTabs } from './ChromeTabs';

// The real MODES labels — used instead of guessed 'Code'/'Domain' literals so the test tracks the
// single source of truth. (Today: Domain / Code / Docs.)
const label = (id: string): string => MODES.find((m) => m.id === id)!.label;

describe('ChromeTabs', () => {
  test('clicking a mode button selects it and its aria-selected follows the slice', () => {
    const store = createAppStore();
    const { container, getByText } = render(<ChromeTabs store={store} />);

    // Clicking the Code mode button drives the slice (mode + the derived center).
    act(() => {
      (getByText(label('code')) as HTMLButtonElement).click();
    });
    expect(store.getState().mode).toBe('code');
    expect(store.getState().center).toBe('technical');

    const codeBtn = Array.from(container.querySelectorAll<HTMLElement>('.mode-btn')).find(
      (b) => b.dataset.mode === 'code',
    )!;
    expect(codeBtn.getAttribute('aria-selected')).toBe('true');

    // The active button cannot diverge from the shown center: setting the mode externally re-derives the
    // aria of every button (both the button highlight AND the center view come from the one slice value).
    act(() => {
      store.getState().setMode('domain');
    });
    expect(codeBtn.getAttribute('aria-selected')).toBe('false');
    const domainBtn = Array.from(container.querySelectorAll<HTMLElement>('.mode-btn')).find(
      (b) => b.dataset.mode === 'domain',
    )!;
    expect(domainBtn.getAttribute('aria-selected')).toBe('true');
  });

  test('renders one button per mode, each labelled and tagged with its id', () => {
    const store = createAppStore();
    const { container } = render(<ChromeTabs store={store} />);
    const buttons = Array.from(container.querySelectorAll<HTMLElement>('.mode-btn'));
    expect(buttons.map((b) => b.dataset.mode)).toEqual(MODES.map((m) => m.id));
    expect(buttons.map((b) => b.textContent)).toEqual(MODES.map((m) => m.label));
  });
});
