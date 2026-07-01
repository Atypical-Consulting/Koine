import { describe, expect, test, vi } from 'vitest';
import { act, fireEvent, render } from '@testing-library/preact';
import { createAppStore } from '@/store/index';
import { EmitTargetSelector } from '@/shell/EmitTargetSelector';

const trigger = (c: Element) => c.querySelector<HTMLButtonElement>('button.emit')!;
const menuItems = (c: Element) => Array.from(c.querySelectorAll<HTMLButtonElement>('.emit-menu-item'));

describe('EmitTargetSelector', () => {
  test('shows the current emit target from the store and no menu until opened', () => {
    const store = createAppStore();
    const { container } = render(<EmitTargetSelector store={store} onChange={() => {}} />);

    // The default store value is csharp → the C# label + a language dot keyed to the id.
    expect(trigger(container).querySelector('.emit-name')!.textContent).toBe('C#');
    expect(trigger(container).querySelector('.lang-dot')!.getAttribute('data-lang')).toBe('csharp');
    expect(trigger(container).getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('.emit-menu')).toBeNull();
  });

  test('reflects a store change (e.g. a Settings-driven switch) without reopening', () => {
    const store = createAppStore();
    const { container } = render(<EmitTargetSelector store={store} onChange={() => {}} />);

    act(() => store.getState().setEmitTarget('typescript'));
    expect(trigger(container).querySelector('.emit-name')!.textContent).toBe('TypeScript');
  });

  test('opening lists every emit target and marks the current one checked', () => {
    const store = createAppStore();
    const { container } = render(<EmitTargetSelector store={store} onChange={() => {}} />);

    fireEvent.click(trigger(container));
    expect(trigger(container).getAttribute('aria-expanded')).toBe('true');
    const labels = menuItems(container).map((b) => b.querySelector('.emit-menu-name')!.textContent);
    // The built-in targets are offered (C# first); the exact tail may grow as the backend seeds more.
    expect(labels).toContain('C#');
    expect(labels).toContain('TypeScript');
    expect(labels).toContain('Python');
    expect(labels).toContain('PHP');
    const checked = menuItems(container).find((b) => b.getAttribute('aria-checked') === 'true');
    expect(checked!.querySelector('.emit-menu-name')!.textContent).toBe('C#');
  });

  test('picking a different target commits it via onChange and closes the menu', () => {
    const store = createAppStore();
    const onChange = vi.fn();
    const { container } = render(<EmitTargetSelector store={store} onChange={onChange} />);

    fireEvent.click(trigger(container));
    const py = menuItems(container).find((b) => b.querySelector('.emit-menu-name')!.textContent === 'Python')!;
    fireEvent.click(py);

    expect(onChange).toHaveBeenCalledExactlyOnceWith('python');
    expect(container.querySelector('.emit-menu')).toBeNull(); // closed
  });

  test('re-picking the current target is a no-op (no redundant commit)', () => {
    const store = createAppStore();
    const onChange = vi.fn();
    const { container } = render(<EmitTargetSelector store={store} onChange={onChange} />);

    fireEvent.click(trigger(container));
    const cs = menuItems(container).find((b) => b.querySelector('.emit-menu-name')!.textContent === 'C#')!;
    fireEvent.click(cs);

    expect(onChange).not.toHaveBeenCalled();
  });
});
