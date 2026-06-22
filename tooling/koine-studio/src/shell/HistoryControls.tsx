import type { StoreApi } from 'zustand/vanilla';
import { useStore } from 'zustand';
import type { AppState } from '@/store/index';

// The top-bar Undo/Redo buttons. Subscribes to the history slice so the buttons enable/disable
// reactively; clicks call into the imperative historyController through plain callbacks, so this panel
// stays free of controller imports (mirrors UnsavedIndicator's onSaveAll seam). Titles are passed in
// already platform-formatted (⌘Z / Ctrl+Z) by ide.tsx via formatChord.
export function HistoryControls(props: {
  store: StoreApi<AppState>;
  onUndo: () => void;
  onRedo: () => void;
  undoTitle: string;
  redoTitle: string;
}) {
  const canUndo = useStore(props.store, (s) => s.canUndo);
  const canRedo = useStore(props.store, (s) => s.canRedo);
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
          <path d="M6 4 2.5 7.5 6 11M2.5 7.5h6.5a4 4 0 0 1 0 8H8" />
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
          <path d="M10 4 13.5 7.5 10 11M13.5 7.5H7a4 4 0 0 0 0 8h1" />
        </svg>
      </button>
    </div>
  );
}
