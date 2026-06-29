// A stable, locale-independent id comparator shared by Studio's view-only stores so two runs serialize
// their items (review threads, diagram notes/groups) in an identical, minimal-diff order. (#480)

/** Stable id comparison (locale-independent) so two runs serialize items identically. */
export function byId(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
