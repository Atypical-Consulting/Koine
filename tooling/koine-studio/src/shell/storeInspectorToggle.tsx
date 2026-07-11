import { render } from 'preact';
import type { ComponentType } from 'preact';
import type { StoreApi } from 'zustand/vanilla';
import type { AppState } from '@/store/index';

type StoreInspectorComponent = ComponentType<{ store: StoreApi<AppState> }>;

export function createStoreInspectorToggle(
  store: StoreApi<AppState>,
  // injected so tests can stub the chunk load; ide.tsx passes () => import('@/shell/StoreInspector')
  load: () => Promise<{ StoreInspector: StoreInspectorComponent }>,
): () => Promise<void> {
  let storeInspectorHost: HTMLElement | null = null;
  let storeInspectorMounting = false;
  let storeInspectorComponent: StoreInspectorComponent | null = null;

  return async function toggleStoreInspector(): Promise<void> {
    if (!storeInspectorHost) {
      // First invocation: load the panel chunk, create the host (visible by default) and render once.
      // Guard against a double-click racing two mounts while the dynamic import is in flight. Return
      // here so we don't immediately flip it back to hidden — the first toggle SHOWS it.
      if (storeInspectorMounting) return;
      storeInspectorMounting = true;
      try {
        const { StoreInspector } = await load();
        storeInspectorComponent = StoreInspector;
        storeInspectorHost = document.createElement('div');
        storeInspectorHost.className = 'koi-store-inspector-overlay';
        document.body.appendChild(storeInspectorHost);
        render(<StoreInspector store={store} />, storeInspectorHost);
      } finally {
        // Always clear the flag — even if the dynamic import rejects — so a failed first attempt
        // doesn't wedge the toggle permanently.
        storeInspectorMounting = false;
      }
      return;
    }
    // Toggle visibility: hide unmounts, show remounts
    if (storeInspectorHost.hidden) {
      // Show: remount the component
      storeInspectorHost.hidden = false;
      if (storeInspectorComponent) {
        const StoreInspectorComponent = storeInspectorComponent;
        render(<StoreInspectorComponent store={store} />, storeInspectorHost);
      }
    } else {
      // Hide: unmount by rendering null, then set hidden
      render(null, storeInspectorHost);
      storeInspectorHost.hidden = true;
    }
  };
}
