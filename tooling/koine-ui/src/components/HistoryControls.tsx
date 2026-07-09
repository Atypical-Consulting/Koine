import { useReadableStore, type ReadableStore } from '../host/store';

/**
 * The slice `HistoryControls` needs from a host's undo/redo state. Deliberately NOT Koine Studio's
 * `HistorySlice` (`tooling/koine-studio/src/store/slices/history.ts`, which also carries the
 * `setHistoryState` mutator) — this is the read-only subset a presentational component depends on.
 */
export interface HistoryControlsSlice {
  canUndo: boolean;
  canRedo: boolean;
}

// The top-bar Undo/Redo buttons. Subscribes to the history slice (via the generic `ReadableStore<T>`
// host-adapter contract, issue #944) so the buttons enable/disable reactively; clicks call into the
// imperative historyController through plain callbacks, so this panel stays free of controller imports
// (mirrors koine-studio's UnsavedIndicator onSaveAll seam). Titles are passed in already
// platform-formatted (⌘Z / Ctrl+Z) by the host (koine-studio's ide.tsx via formatChord).
//
// Moved from `koine-studio/src/shell/HistoryControls.tsx` (issue #944, second-tranche extraction): the
// only change from the original is the `store` prop's type — `ReadableStore<HistoryControlsSlice>`
// instead of Koine Studio's concrete `StoreApi<AppState>` — so this component never imports Zustand or
// `AppState`. The host adapts its real store via `zustandToReadableStore` at the call site.
export function HistoryControls(props: {
  store: ReadableStore<HistoryControlsSlice>;
  onUndo: () => void;
  onRedo: () => void;
  undoTitle: string;
  redoTitle: string;
}) {
  const { canUndo, canRedo } = useReadableStore(props.store);
  return (
    <div class="tb-group" role="group" aria-label="History">
      <button
        type="button"
        class="icon-btn"
        data-role="undo"
        title={props.undoTitle}
        aria-label="Undo"
        disabled={!canUndo}
        onClick={() => props.onUndo()}
      >
        <svg class="tb-ico" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M6.5 3 3.5 6l3 3M3.6 6H10a3.5 3.5 0 0 1 0 7H7" />
        </svg>
      </button>
      <button
        type="button"
        class="icon-btn"
        data-role="redo"
        title={props.redoTitle}
        aria-label="Redo"
        disabled={!canRedo}
        onClick={() => props.onRedo()}
      >
        <svg class="tb-ico" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M9.5 3 12.5 6l-3 3M12.4 6H6a3.5 3.5 0 0 0 0 7h3" />
        </svg>
      </button>
    </div>
  );
}
