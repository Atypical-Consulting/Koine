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
 * The identity of the element being renamed, as carried by `InspectorElement` (which is structurally
 * compatible). Carries enough to match a selection keyed by EITHER name form the model index accepts.
 */
export interface RenamedElementIdentity {
  /** The canonical glossary qualified name, e.g. `Sales.Order.OrderPlaced` — the model index's `byQn` key. */
  qualifiedName: string;
  /** The owning bounded context (the qualified name's first segment). */
  context: string;
  /** The element's simple (leaf) name BEFORE the rename. */
  name: string;
}

/**
 * Re-key the selection after an element is renamed (issue #537). Selection is keyed by qualified name,
 * but a rename rebuilds the model under a NEW qualified name — so the stored selection goes stale and
 * every name-keyed consumer breaks at once (the Properties panel's `lookupElement` misses → empty
 * state; the toolbar breadcrumb renders the old leaf). The rename path calls this right after the edit
 * applies to re-anchor the selection to the element's new identity.
 *
 * A selection can be keyed by EITHER form the model index resolves: the canonical glossary qn
 * (`Context.Aggregate.Name`, stored by the outline / domain navigator / Properties) OR a diagram-node
 * alias (`Context.Name`, stored by the Events table / Events-Flow canvas — see `qnByCtxName` in
 * modelIndex.ts). Both name the same element, so we match either; only then is the selection re-anchored.
 * Any other (or absent) selection is returned UNCHANGED — same reference — so the caller can cheaply skip
 * the store write and renaming a non-selected element never hijacks the selection.
 *
 * The new selection is the renamed element's new CANONICAL qn (a direct `byQn` hit): the canonical qn's
 * leaf segment swapped for `newName`, keeping the context prefix (a NAME rename can't move an element
 * between contexts). The breadcrumb's leaf (`qn.split('.').pop()`) is the same under either form, so it
 * follows the new name regardless of which form the user originally selected.
 */
export function reanchorSelectionAfterRename(
  sel: SelectedElement | null,
  renamed: RenamedElementIdentity,
  newName: string,
): SelectedElement | null {
  if (!sel) return sel;
  const canonicalQn = renamed.qualifiedName;
  const aliasQn = `${renamed.context}.${renamed.name}`;
  if (sel.qualifiedName !== canonicalQn && sel.qualifiedName !== aliasQn) return sel;
  const dot = canonicalQn.lastIndexOf('.');
  const newQn = dot >= 0 ? `${canonicalQn.slice(0, dot + 1)}${newName}` : newName;
  return { qualifiedName: newQn, context: renamed.context };
}
