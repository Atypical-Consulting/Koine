import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import type { StoreApi } from 'zustand/vanilla';
import type { AppState } from '@/store/index';
import { createStoreInspectorToggle } from './storeInspectorToggle';

describe('storeInspectorToggle', () => {
  let store: StoreApi<AppState>;
  let hostElement: HTMLElement | null;

  beforeEach(() => {
    // Create a minimal test store
    store = createStore<AppState>(() => ({
      selection: null,
      activeContext: null,
      center: 'code',
      tech: 'csharp',
      docs: {},
      bottom: 'output',
      right: 'properties',
      activeUri: null,
      buffers: new Map(),
      diagnosticsByUri: {},
      docViews: {},
      chat: { messages: [], status: 'idle', changeSet: null },
      // Add any other required fields with minimal values
    } as AppState));

    // Clean up any existing host from previous tests
    hostElement = document.querySelector('.koi-store-inspector-overlay');
    if (hostElement) {
      hostElement.remove();
    }
  });

  afterEach(() => {
    // Clean up the host after each test
    hostElement = document.querySelector('.koi-store-inspector-overlay');
    if (hostElement) {
      hostElement.remove();
    }
  });

  it('first toggle creates and mounts the host with the component', async () => {
    const mockLoad = vi.fn(async () => ({
      StoreInspector: () => null,
    }));

    const toggle = createStoreInspectorToggle(store, mockLoad);

    await toggle();

    const host = document.querySelector('.koi-store-inspector-overlay');
    expect(host).not.toBeNull();
    expect(host?.hidden).toBe(false);
    expect(mockLoad).toHaveBeenCalledOnce();
  });

  it('second toggle hides the overlay', async () => {
    const mockLoad = vi.fn(async () => ({
      StoreInspector: () => null,
    }));

    const toggle = createStoreInspectorToggle(store, mockLoad);

    // First toggle: show
    await toggle();
    const host = document.querySelector('.koi-store-inspector-overlay');
    expect(host?.hidden).toBe(false);

    // Second toggle: hide
    await toggle();
    expect(host?.hidden).toBe(true);
  });

  it('concurrent toggles during mount mount only once', async () => {
    const mockLoad = vi.fn(async () => {
      // Simulate a slow load to allow race condition
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { StoreInspector: () => null };
    });

    const toggle = createStoreInspectorToggle(store, mockLoad);

    // Fire two toggles concurrently
    await Promise.all([toggle(), toggle()]);

    expect(mockLoad).toHaveBeenCalledOnce();
    const host = document.querySelector('.koi-store-inspector-overlay');
    expect(host).not.toBeNull();
  });

  it('rejected load allows retry on next toggle', async () => {
    const mockLoad = vi.fn(async () => {
      throw new Error('Load failed');
    });

    const toggle = createStoreInspectorToggle(store, mockLoad);

    // First toggle fails
    await expect(toggle()).rejects.toThrow('Load failed');

    // Retry with a successful load
    const mockLoad2 = vi.fn(async () => ({
      StoreInspector: () => null,
    }));

    const toggle2 = createStoreInspectorToggle(store, mockLoad2);
    await toggle2();

    const host = document.querySelector('.koi-store-inspector-overlay');
    expect(host).not.toBeNull();
  });

  it('load is called exactly once across show-hide-show cycles', async () => {
    const mockLoad = vi.fn(async () => ({
      StoreInspector: () => null,
    }));

    const toggle = createStoreInspectorToggle(store, mockLoad);

    // Show
    await toggle();
    expect(mockLoad).toHaveBeenCalledOnce();

    // Hide
    await toggle();
    expect(mockLoad).toHaveBeenCalledOnce();

    // Show again
    await toggle();
    expect(mockLoad).toHaveBeenCalledOnce();
  });
});
