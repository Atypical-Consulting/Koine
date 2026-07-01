import { describe, expect, test } from 'vitest';
import { act, render } from '@testing-library/preact';
import { createAppStore } from '@/store/index';
import { DocsCoverageRing } from '@/shell/DocsCoverageRing';

const R = 15;
const CIRC = 2 * Math.PI * R;
const label = (c: Element) => c.querySelector('.sb-ring-label')!.textContent;
const arc = (c: Element) => c.querySelectorAll('circle')[1]; // [0] = track, [1] = progress arc

describe('DocsCoverageRing', () => {
  test('renders Docs 0/0 with an empty arc for an empty/absent model', () => {
    const store = createAppStore();
    const { container } = render(<DocsCoverageRing store={store} />);
    expect(label(container)).toBe('Docs 0/0');
    expect(arc(container).getAttribute('stroke-dasharray')).toBe(`0 ${Math.round(CIRC * 100) / 100}`);
  });

  test('renders the documented fraction as a half arc for 1/2', () => {
    const store = createAppStore();
    act(() => store.getState().setDocsCoverage({ documented: 1, total: 2 }));
    const { container } = render(<DocsCoverageRing store={store} />);
    expect(label(container)).toBe('Docs 1/2');
    const half = Math.round(CIRC * 0.5 * 100) / 100;
    expect(arc(container).getAttribute('stroke-dasharray')).toBe(`${half} ${Math.round((CIRC - half) * 100) / 100}`);
  });

  test('a full glossary fills the arc and tracks store changes reactively', () => {
    const store = createAppStore();
    const { container } = render(<DocsCoverageRing store={store} />);
    act(() => store.getState().setDocsCoverage({ documented: 3, total: 3 }));
    expect(label(container)).toBe('Docs 3/3');
    const full = Math.round(CIRC * 100) / 100;
    expect(arc(container).getAttribute('stroke-dasharray')).toBe(`${full} 0`);
  });
});
