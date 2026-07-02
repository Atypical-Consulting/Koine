import { afterEach, describe, expect, test } from 'vitest';
import { act, cleanup, render } from '@testing-library/preact';
import { useAppStore } from '@/store/hooks';
import { appStore, createAppStore } from '@/store/index';

// Pins the behavior of both `useAppStore` overloads BEFORE the rules-of-hooks refactor so the change
// (resolving (store, selector) first, then one unconditional `useStore` call) is proven behavior-
// preserving: each overload subscribes a component to exactly its selected slice — re-rendering when
// that slice changes and NOT when an unrelated slice does. `emitTarget` is the selected slice;
// `navAltitude` is the unrelated one (both plain scalars with no-churn setters).
describe('useAppStore', () => {
  afterEach(() => cleanup());

  test('1-arg overload (singleton store): re-renders on its slice, not on an unrelated slice', () => {
    let renders = 0;
    function Probe() {
      renders++;
      return <span>{useAppStore((s) => s.emitTarget)}</span>;
    }
    // Known baseline on the shared singleton (vitest isolates modules per file, but be explicit).
    act(() => {
      appStore.getState().setEmitTarget('csharp');
      appStore.getState().setNavAltitude('strategic');
    });

    const { container } = render(<Probe />);
    expect(container.textContent).toBe('csharp');
    const base = renders;

    // Unrelated slice change → the selected value is unchanged → no re-render.
    act(() => appStore.getState().setNavAltitude('tactical'));
    expect(renders).toBe(base);

    // Selected slice change → exactly one re-render, with the new value.
    act(() => appStore.getState().setEmitTarget('typescript'));
    expect(renders).toBe(base + 1);
    expect(container.textContent).toBe('typescript');
  });

  test('2-arg overload (injected store): re-renders on its slice, not on an unrelated slice', () => {
    const store = createAppStore();
    let renders = 0;
    function Probe() {
      renders++;
      return <span>{useAppStore(store, (s) => s.emitTarget)}</span>;
    }

    const { container } = render(<Probe />);
    expect(container.textContent).toBe('csharp');
    const base = renders;

    // Unrelated slice change on the injected store → no re-render.
    act(() => store.getState().setNavAltitude('tactical'));
    expect(renders).toBe(base);

    // Selected slice change → exactly one re-render, with the new value.
    act(() => store.getState().setEmitTarget('php'));
    expect(renders).toBe(base + 1);
    expect(container.textContent).toBe('php');

    // The injected store is isolated from the singleton — mutating it must not touch appStore.
    expect(appStore.getState().emitTarget).not.toBe('php');
  });
});
