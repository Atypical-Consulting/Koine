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

/**
 * Re-key the selection after an element is renamed (issue #537). Selection is keyed by qualified name,
 * but a rename rebuilds the model under a NEW qualified name — so the stored selection goes stale and
 * every name-keyed consumer breaks at once (the Properties panel's `lookupElement` misses → empty
 * state; the toolbar breadcrumb renders the old leaf). The rename path calls this right after the edit
 * applies to re-anchor the selection to the element's new identity.
 *
 * Only the selection that points at the renamed element (`renamedQn`) is re-anchored; any other (or
 * absent) selection is returned UNCHANGED — same reference — so the caller can cheaply skip the store
 * write and renaming a non-selected element never hijacks the selection. The new qualified name swaps
 * the leaf segment for `newName` while keeping the context prefix (a NAME rename can't move an element
 * between contexts), matching how the model index keys the rebuilt element.
 */
export function reanchorSelectionAfterRename(
  sel: SelectedElement | null,
  renamedQn: string,
  newName: string,
): SelectedElement | null {
  if (!sel || sel.qualifiedName !== renamedQn) return sel;
  const dot = renamedQn.lastIndexOf('.');
  const newQn = dot >= 0 ? `${renamedQn.slice(0, dot + 1)}${newName}` : newName;
  return { qualifiedName: newQn, context: sel.context };
}
