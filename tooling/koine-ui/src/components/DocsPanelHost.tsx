import { useRef } from 'preact/hooks';
import { useReadableStore, type ReadableStore } from '../host/store';

/**
 * The slice `DocsPanelHost` needs from a host's workspace state: an opaque token identifying the
 * current workspace folder. The component never interprets it — it only reloads when the token
 * CHANGES. Koine Studio's adapter (`createDocsPanelHostStore` in `src/store/readableStores.ts`)
 * forwards the workspace slice's `folderRootToken` (`roots[0] ?? ''`).
 */
export interface DocsPanelHostSlice {
  /** Opaque identity of the current workspace folder ('' before any folder opens). */
  folderRootToken: string;
}

// A folder-derived Documentation page as a Preact host (#193, #174) — reused for both the Decisions
// (ADR) and Notes pages. It subscribes ONLY to the host's `folderRootToken`, NOT to model edits — the
// pages are folder-derived (ADRs/notes are Markdown under docs/), so each must reload when the
// workspace folder changes and stay put across `.koi` edits, exactly the `invalidateDocsPanel`
// contract. On mount it hands the controller the mount node (so the lazy first-load + in-panel
// create/save reloads can paint into it); thereafter it asks the controller to reload ONLY when the
// folder token actually changes — never on a re-render driven by an unrelated parent paint, and never
// on the initial empty-folder mount (the controller's lazy tab-open path owns that first paint). The
// controller's `load`/`onMount` paint the real docs pages (Koine Studio's `<AdrPanel>` / `<NotesPanel>`
// JSX, #992 task 5, via surfaceLoaders.tsx's `renderPanel` unmount-first helper) into the node; this
// component only governs WHEN it reloads. Mounted through a callback ref so that imperative (re)paint
// and the Preact reconciler never fight over the same node.
//
// Moved from `koine-studio/src/docs/DocsPanelHost.tsx` (issue #1244, third-tranche extraction): the
// only change from the original is the `store` prop's type — `ReadableStore<DocsPanelHostSlice>`
// instead of Koine Studio's concrete `StoreApi<AppState>` — so this component never imports Zustand or
// `AppState`. The host adapts its real store via `zustandToReadableStore` at the call site.
export function DocsPanelHost(props: {
  store: ReadableStore<DocsPanelHostSlice>;
  /** Hand the controller the mount node on first mount (capture only — no fetch). */
  onMount: (host: HTMLElement) => void;
  /** (Re)render the folder-derived docs into the mount node on a folder-token change. */
  load: (host: HTMLElement) => void;
}) {
  const { store, onMount, load } = props;
  const { folderRootToken: token } = useReadableStore(store);
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
