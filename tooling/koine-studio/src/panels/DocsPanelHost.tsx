import { useRef } from 'preact/hooks';
import type { StoreApi } from 'zustand/vanilla';
import type { AppState } from '../store/index';
import { useAppStore } from '../store/hooks';

// The ADR/Notes Documentation surface as a Preact host (#193, #174). It subscribes ONLY to the
// `workspace` slice's `folderRootToken`, NOT to model edits — the panel is folder-derived (ADRs/notes
// are Markdown under docs/), so it must reload when the workspace folder changes and stay put across
// `.koi` edits, exactly the existing `invalidateDocsPanel` contract. On mount it hands the controller
// the mount node (so the lazy first-load + in-panel create/save reloads can paint into it); thereafter
// it asks the controller to reload ONLY when the folder token actually changes — never on a re-render
// driven by an unrelated parent paint, and never on the initial empty-folder mount (the controller's
// lazy tab-open path owns that first paint). The pure `renderDocsPanel` is reused untouched inside the
// controller's `load`/`onMount`; this component only governs WHEN it reloads. Mounted through a
// callback ref so the imperative renderer and the Preact reconciler never fight over the same node.
export function DocsPanelHost(props: {
  store: StoreApi<AppState>;
  /** Hand the controller the mount node on first mount (capture only — no fetch). */
  onMount: (host: HTMLElement) => void;
  /** (Re)render the folder-derived docs into the mount node on a folder-token change. */
  load: (host: HTMLElement) => void;
}) {
  const { store, onMount, load } = props;
  const token = useAppStore(store, (s) => s.folderRootToken);
  // The mount node, captured once. Folder reloads paint into the same node.
  const hostRef = useRef<HTMLElement | null>(null);
  // The token the node was last loaded for. `undefined` until the first mount, so the initial paint is
  // a capture (the controller's lazy path owns it), and only an actual folder CHANGE triggers a reload.
  const loadedToken = useRef<string | undefined>(undefined);

  return (
    <div
      class="koi-docs-mount"
      ref={(host: HTMLElement | null) => {
        if (!host) return;
        if (hostRef.current !== host) {
          // First real mount of this node: capture it and record the current token without fetching.
          hostRef.current = host;
          loadedToken.current = token;
          onMount(host);
          return;
        }
        if (loadedToken.current === token) return; // folder unchanged — keep the current render
        loadedToken.current = token;
        load(host);
      }}
    />
  );
}
