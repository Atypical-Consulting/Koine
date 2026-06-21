// The selected-element bus (#142, Task 1): a tiny observable store shared by the model outline, the
// diagram canvas, and the element inspector. Selecting a node anywhere sets one selection; the
// inspector (and cross-highlighting) subscribe to it. Pure and dependency-free so it unit-tests
// without any DOM or LSP wiring.
import type { SourceSpan } from './lsp';

/** The element currently selected in the workspace, identified by its dotted qualified name. */
export interface SelectedElement {
  /** Dotted stable name, e.g. 'Ordering.Order' — the key used to look the node up in the model graph. */
  qualifiedName: string;
  /** Owning bounded context, e.g. 'Ordering'. */
  context: string;
  /** The declaration's RAW 1-based source span for jump-to-source, or null when it has no position. */
  span: SourceSpan | null;
}

type Listener = (selection: SelectedElement | null) => void;

export interface SelectionBus {
  /** The current selection, or null when nothing is selected. */
  get(): SelectedElement | null;
  /** Set (or clear, with null) the selection and notify every subscriber. */
  set(selection: SelectedElement | null): void;
  /** Subscribe to selection changes; returns an unsubscribe function. */
  subscribe(listener: Listener): () => void;
}

/**
 * Create a fresh selection bus. `set` always notifies — even when the value is identical — because
 * re-selecting an already-selected node (e.g. clicking it again to re-focus the inspector) is a
 * meaningful action, not a no-op.
 */
export function createSelectionBus(): SelectionBus {
  let current: SelectedElement | null = null;
  const listeners = new Set<Listener>();
  return {
    get: () => current,
    set: (selection) => {
      current = selection;
      for (const listener of listeners) listener(current);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
