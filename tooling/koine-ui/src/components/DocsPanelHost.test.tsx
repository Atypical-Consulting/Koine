import { describe, expect, test, vi } from 'vitest';
import { act, render } from '@testing-library/preact';
import { DocsPanelHost, type DocsPanelHostSlice } from './DocsPanelHost';
import { createTestReadableStore } from '../host/storeTestUtils';

// The shared ReadableStore<T> test double (host/storeTestUtils) — koine-ui is store-free, so it mocks
// the contract directly instead of pulling in koine-studio's real Zustand store. The token derivation
// (`roots[0] ?? ''`) is the host's workspace slice's job, pinned in koine-studio's tests; this file
// covers the host component's capture-then-reload-on-change contract, which had no direct unit
// coverage on the koine-studio side (it was pinned only through controller integration tests).

describe('DocsPanelHost', () => {
  test('first mount CAPTURES the node via onMount without fetching (the lazy tab-open path owns that paint)', () => {
    const store = createTestReadableStore<DocsPanelHostSlice>({ folderRootToken: 'WS-A' });
    const onMount = vi.fn();
    const load = vi.fn();
    const { container } = render(<DocsPanelHost store={store} onMount={onMount} load={load} />);

    const host = container.querySelector('.koi-docs-mount');
    expect(host).not.toBeNull();
    expect(onMount).toHaveBeenCalledTimes(1);
    expect(onMount).toHaveBeenCalledWith(host);
    expect(load).not.toHaveBeenCalled();
  });

  test('a folder-token change reloads into the SAME captured node; an unchanged token never does', () => {
    const store = createTestReadableStore<DocsPanelHostSlice>({ folderRootToken: 'WS-A' });
    const onMount = vi.fn();
    const load = vi.fn();
    const { container } = render(<DocsPanelHost store={store} onMount={onMount} load={load} />);
    const host = container.querySelector('.koi-docs-mount');

    // A re-render that does NOT change the token (the host notifying an identical slice models an
    // unrelated parent paint) keeps the current render — no reload.
    act(() => store.set({ folderRootToken: 'WS-A' }));
    expect(load).not.toHaveBeenCalled();

    // A REAL folder change reloads, into the same captured mount node.
    act(() => store.set({ folderRootToken: 'WS-B' }));
    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith(host);
    // The node was captured once — the reload did not re-run the first-mount capture.
    expect(onMount).toHaveBeenCalledTimes(1);

    // Switching again reloads again; switching to the SAME token does not.
    act(() => store.set({ folderRootToken: 'WS-B' }));
    expect(load).toHaveBeenCalledTimes(1);
    act(() => store.set({ folderRootToken: 'WS-C' }));
    expect(load).toHaveBeenCalledTimes(2);
  });
});
