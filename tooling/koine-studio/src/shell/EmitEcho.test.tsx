import { describe, expect, test } from 'vitest';
import { act, render } from '@testing-library/preact';
import { createAppStore } from '@/store/index';
import { EmitEcho } from '@/shell/EmitEcho';

describe('EmitEcho', () => {
  test('mirrors the store emit target as a label + language dot', () => {
    const store = createAppStore();
    const { container } = render(<EmitEcho store={store} />);
    expect(container.querySelector('.sb-emit-label')!.textContent).toBe('Emit: C#');
    expect(container.querySelector('.lang-dot')!.getAttribute('data-lang')).toBe('csharp');
  });

  test('tracks store changes reactively (single home with the top-bar selector)', () => {
    const store = createAppStore();
    const { container } = render(<EmitEcho store={store} />);
    act(() => store.getState().setEmitTarget('php'));
    expect(container.querySelector('.sb-emit-label')!.textContent).toBe('Emit: PHP');
    expect(container.querySelector('.lang-dot')!.getAttribute('data-lang')).toBe('php');
  });
});
