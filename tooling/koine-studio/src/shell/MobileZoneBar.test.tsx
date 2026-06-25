import { describe, expect, test, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/preact';
import { axe } from 'vitest-axe';
import { createAppStore } from '@/store/index';
import { MobileZoneBar } from '@/shell/MobileZoneBar';

const tabs = (c: Element) => Array.from(c.querySelectorAll('[role="tab"]')) as HTMLButtonElement[];

describe('MobileZoneBar', () => {
  test('renders four tabs in a tablist', () => {
    const store = createAppStore();
    const { container } = render(<MobileZoneBar store={store} onSelect={() => {}} />);
    expect(container.querySelector('[role="tablist"]')).not.toBeNull();
    expect(tabs(container).map((t) => t.dataset.zone)).toEqual(['files', 'code', 'diagram', 'props']);
  });
  test('marks the active zone aria-selected from the store', () => {
    const store = createAppStore();
    store.getState().setMobileZone('diagram');
    const { container } = render(<MobileZoneBar store={store} onSelect={() => {}} />);
    const sel = tabs(container).find((t) => t.getAttribute('aria-selected') === 'true');
    expect(sel?.dataset.zone).toBe('diagram');
  });
  test('clicking a tab calls onSelect with its zone', () => {
    const store = createAppStore();
    const onSelect = vi.fn();
    const { container } = render(<MobileZoneBar store={store} onSelect={onSelect} />);
    fireEvent.click(tabs(container).find((t) => t.dataset.zone === 'props')!);
    expect(onSelect).toHaveBeenCalledWith('props');
  });
  test('arrow keys move between tabs (roving tabindex)', () => {
    const store = createAppStore();
    const onSelect = vi.fn();
    const { container } = render(<MobileZoneBar store={store} onSelect={onSelect} />);
    // Active zone defaults to 'code' (index 1); ArrowRight → 'diagram', Home → 'files', End → 'props'.
    const code = tabs(container).find((t) => t.dataset.zone === 'code')!;
    fireEvent.keyDown(code, { key: 'ArrowRight' });
    expect(onSelect).toHaveBeenLastCalledWith('diagram');
    fireEvent.keyDown(code, { key: 'Home' });
    expect(onSelect).toHaveBeenLastCalledWith('files');
    fireEvent.keyDown(code, { key: 'End' });
    expect(onSelect).toHaveBeenLastCalledWith('props');
  });
  test('has no axe violations', async () => {
    const store = createAppStore();
    const { container } = render(<MobileZoneBar store={store} onSelect={() => {}} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
