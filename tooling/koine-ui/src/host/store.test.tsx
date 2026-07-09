import { afterEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/preact';
import { useReadableStore, type ReadableStore } from './store';

// ---------------------------------------------------------------------------
// A minimal mock ReadableStore<T> — no Zustand, matching what a real adapter would hand a component.
// ---------------------------------------------------------------------------

interface MockStore<T> extends ReadableStore<T> {
  set(next: T): void;
}

function createMockStore<T>(initial: T): MockStore<T> {
  let state = initial;
  const listeners = new Set<(state: T) => void>();
  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(next) {
      state = next;
      for (const listener of listeners) listener(next);
    },
  };
}

// Pins useReadableStore's contract in isolation (mirrors koine-studio's store/hooks.test.tsx style for
// its own useAppStore): initial read, re-render on change, unsubscribe on unmount, resubscribe when the
// store instance itself changes, and the mount-time resync that closes the render/effect race window.
describe('useReadableStore', () => {
  afterEach(() => cleanup());

  test('returns the store’s current state on first render', () => {
    const store = createMockStore({ count: 1 });
    function Probe() {
      const { count } = useReadableStore(store);
      return <span>{count}</span>;
    }
    const { container } = render(<Probe />);
    expect(container.textContent).toBe('1');
  });

  test('re-renders with the new value when the store notifies a change', () => {
    const store = createMockStore({ count: 1 });
    let renders = 0;
    function Probe() {
      renders++;
      const { count } = useReadableStore(store);
      return <span>{count}</span>;
    }
    render(<Probe />);
    const base = renders;

    act(() => store.set({ count: 2 }));

    expect(renders).toBe(base + 1);
  });

  test('renders the new value after a notification', () => {
    const store = createMockStore({ count: 1 });
    function Probe() {
      const { count } = useReadableStore(store);
      return <span>{count}</span>;
    }
    const { container } = render(<Probe />);
    act(() => store.set({ count: 42 }));
    expect(container.textContent).toBe('42');
  });

  test('unsubscribes from the store on unmount', () => {
    const store = createMockStore({ count: 1 });
    const disposeSpy = vi.fn();
    const wrapped: ReadableStore<{ count: number }> = {
      getState: () => store.getState(),
      subscribe: (listener) => {
        const dispose = store.subscribe(listener);
        return () => {
          dispose();
          disposeSpy();
        };
      },
    };
    function Probe() {
      const { count } = useReadableStore(wrapped);
      return <span>{count}</span>;
    }
    const { unmount } = render(<Probe />);
    expect(disposeSpy).not.toHaveBeenCalled();

    unmount();

    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });

  test('a change on a store after unmount is a safe no-op (no post-unmount setState)', () => {
    const store = createMockStore({ count: 1 });
    function Probe() {
      const { count } = useReadableStore(store);
      return <span>{count}</span>;
    }
    const { unmount } = render(<Probe />);
    unmount();

    // Would throw/warn if the hook still held a live setState after unmount; the subscription must have
    // been torn down by the cleanup above.
    expect(() => act(() => store.set({ count: 99 }))).not.toThrow();
  });

  test('resubscribes when the store prop itself changes to a different instance', () => {
    const storeA = createMockStore({ label: 'a' });
    const storeB = createMockStore({ label: 'b' });
    function Probe(props: { store: ReadableStore<{ label: string }> }) {
      const { label } = useReadableStore(props.store);
      return <span>{label}</span>;
    }
    const { container, rerender } = render(<Probe store={storeA} />);
    expect(container.textContent).toBe('a');

    rerender(<Probe store={storeB} />);
    expect(container.textContent).toBe('b');

    // A change on the OLD store must no longer reach the component.
    act(() => storeA.set({ label: 'stale' }));
    expect(container.textContent).toBe('b');

    // A change on the NEW store does.
    act(() => storeB.set({ label: 'fresh' }));
    expect(container.textContent).toBe('fresh');
  });

  test('resyncs getState() in the mount effect (closes the render/effect race window)', () => {
    const store = createMockStore({ count: 1 });
    const getStateSpy = vi.spyOn(store, 'getState');
    function Probe() {
      const { count } = useReadableStore(store);
      return <span>{count}</span>;
    }
    render(<Probe />);

    // Once for the lazy useState initializer, at least once more for the effect's resync read.
    expect(getStateSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
