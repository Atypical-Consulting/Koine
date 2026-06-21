// The shared "selected element" bus (issue #142). It is the spine of the DDD-aware workspace: a
// single source of truth for which domain element is selected, so the model outline, the diagram,
// and the element inspector all stay in sync. Clicking a node in the outline OR a node in the
// diagram sets the same selection; the inspector (and outline cross-highlight) subscribe to it.
//
// Deliberately tiny and dependency-free — a minimal observable store, unit-testable under happy-dom.
// It carries only the *identity* of the selection (qualified name + owning context); subscribers
// resolve the rest (members, doc, source range) from the model index they already hold.

/** The identity of the currently-selected domain element, or the absence of one. */
export interface SelectedElement {
  /** Dotted stable name, e.g. `Ordering.Order` — the key into the model index. */
  qualifiedName: string;
  /** The owning bounded context (the qualified name's first segment). */
  context: string;
}

export interface SelectionBus {
  /** The current selection, or `null` when nothing is selected. */
  get(): SelectedElement | null;
  /** Replace the selection (or clear it with `null`) and notify every subscriber. */
  set(element: SelectedElement | null): void;
  /** Subscribe to selection changes; returns an unsubscribe handle. */
  subscribe(fn: (element: SelectedElement | null) => void): () => void;
}

/** Creates an independent selection bus. */
export function createSelectionBus(): SelectionBus {
  let current: SelectedElement | null = null;
  const subscribers = new Set<(element: SelectedElement | null) => void>();

  return {
    get: () => current,
    set(element) {
      current = element;
      // Snapshot before iterating so a subscriber that unsubscribes mid-notify can't mutate the set.
      for (const fn of [...subscribers]) fn(current);
    },
    subscribe(fn) {
      subscribers.add(fn);
      return () => {
        subscribers.delete(fn);
      };
    },
  };
}
