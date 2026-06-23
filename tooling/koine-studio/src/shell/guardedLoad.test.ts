import { describe, expect, test, vi } from 'vitest';
import { createAppStore } from '@/store/index';
import { guardedLoad } from '@/shell/guardedLoad';

// The stale-token discipline the bottom-strip + glossary loaders share. The controller's own tests cover
// load-once and refetch-after-invalidate, but NOT the mid-fetch supersede-discard (an edit lands while a
// fetch is in flight) — that race is pinned here, against a real store's docViews slice.

describe('guardedLoad', () => {
  test('renders the data and marks the view loaded for a current fetch', async () => {
    const store = createAppStore();
    const loading = vi.fn();
    const render = vi.fn();
    await guardedLoad({ store, key: 'glossary', loading, fetch: async () => 'DATA', render, onError: vi.fn() });

    expect(loading).toHaveBeenCalledOnce();
    expect(render).toHaveBeenCalledWith('DATA');
    expect(store.getState().isStale('glossary')).toBe(false);
  });

  test('discards a superseded fetch: an edit mid-fetch means no render and no markLoaded', async () => {
    const store = createAppStore();
    const render = vi.fn();
    await guardedLoad({
      store,
      key: 'glossary',
      fetch: async () => {
        store.getState().invalidate('glossary'); // an edit bumps the token while the fetch is in flight
        return 'STALE';
      },
      render,
      onError: vi.fn(),
    });

    expect(render).not.toHaveBeenCalled();
    expect(store.getState().isStale('glossary')).toBe(true); // never marked loaded
  });

  test('calls onError when the fetch rejects and the load is still current', async () => {
    const store = createAppStore();
    const onError = vi.fn();
    await guardedLoad({
      store,
      key: 'events',
      fetch: async () => {
        throw new Error('boom');
      },
      render: vi.fn(),
      onError,
    });

    expect(onError).toHaveBeenCalledOnce();
    expect(store.getState().isStale('events')).toBe(true);
  });

  test('drops the error too when superseded: onError is not called', async () => {
    const store = createAppStore();
    const onError = vi.fn();
    await guardedLoad({
      store,
      key: 'events',
      fetch: async () => {
        store.getState().invalidate('events');
        throw new Error('boom');
      },
      render: vi.fn(),
      onError,
    });

    expect(onError).not.toHaveBeenCalled();
  });

  test('the loading callback is optional', async () => {
    const store = createAppStore();
    await expect(
      guardedLoad({ store, key: 'contextmap', fetch: async () => 1, render: vi.fn(), onError: vi.fn() }),
    ).resolves.toBeUndefined();
  });
});
