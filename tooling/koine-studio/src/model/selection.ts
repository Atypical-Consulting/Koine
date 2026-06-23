// The "selected element" identity (issue #142). It is the spine of the DDD-aware workspace: a single
// source of truth for which domain element is selected, so the model outline, the diagram, and the
// element inspector all stay in sync. Clicking a node in the outline OR a node in the diagram sets the
// same selection; the inspector (and outline cross-highlight) read it.
//
// The state itself now lives in the app store's `selection` slice (src/store/slices/selection.ts) — the
// single observable everyone subscribes to. This file keeps only the shared identity type: it carries
// only the *identity* of the selection (qualified name + owning context); consumers resolve the rest
// (members, doc, source range) from the model index they already hold.

/** The identity of the currently-selected domain element, or the absence of one. */
export interface SelectedElement {
  /** Dotted stable name, e.g. `Ordering.Order` — the key into the model index. */
  qualifiedName: string;
  /** The owning bounded context (the qualified name's first segment). */
  context: string;
}
