// A pure mapper from the strategic context map (the LSP `koine/contextMap` result) to the same
// structured `{ nodes, edges }` graph the maxGraph canvas already renders (DiagramGraph). It carries NO
// DOM and no maxGraph dependency, so it's plain-logic unit-tested; the inspector feeds its output into
// `buildCanvas()` / the renderer behind the `DiagramRenderer` seam (no second diagram engine). Each
// context node carries its declaration span from the result's `contextSpans` map (#290), so the canvas's
// existing jump-to-source listener navigates to the `.koi` on a context-node click.
import type { AclMapping, ContextMapResult, DiagramEdge, DiagramGraph, DiagramNode, SourceSpan } from '@/lsp/lsp';

/** The node kind for a bounded context — styled distinctly from class/aggregate nodes on the canvas. */
export const CONTEXT_NODE_KIND = 'context';

/**
 * A context-map edge: a {@link DiagramEdge} plus the strategic-relation metadata the inspector surfaces
 * on hover/selection. The extra fields are frontend-derived from the ContextMapResult and ride the cell
 * value, so nothing from the old table is lost — they're kept OFF the wire `DiagramEdge` DTO on purpose.
 */
export interface ContextMapEdge extends DiagramEdge {
  /** Symmetric relation (Partnership / Shared Kernel) → drawn undirected/two-headed. */
  bidirectional: boolean;
  /** Types shared across the relation (the Published Language / Shared Kernel surface). */
  sharedTypes: string[];
  /** Anticorruption-layer mappings (upstream type → local type) declared on the relation. */
  acl: AclMapping[];
}

/**
 * A {@link DiagramGraph} whose edges carry context-map relation metadata. It stays assignable to
 * DiagramGraph (a ContextMapEdge is a DiagramEdge), so it feeds `buildCanvas` / the renderer unchanged.
 */
export interface ContextMapGraph extends DiagramGraph {
  nodes: DiagramNode[];
  edges: ContextMapEdge[];
}

/** One bounded-context box. The qualified name is the bare context name (undotted) so `contextOf()`
 *  reports no owning context and the renderer places it at the root, not inside a swimlane. The span is
 *  the context's declaration position (#290) — null for a dangling endpoint or a recovered parse, which
 *  keeps the node inert to jump-to-source. */
function contextNode(name: string, sourceSpan: SourceSpan | null): DiagramNode {
  return {
    id: name,
    label: name,
    kind: CONTEXT_NODE_KIND,
    qualifiedName: name,
    sourceSpan,
    stereotype: null,
    members: [],
  };
}

/**
 * Map a {@link ContextMapResult} to the interactive graph model: one node per bounded context, one edge
 * per relation (source = upstream, target = downstream, so the arrow reads upstream → downstream). A
 * bidirectional relation is flagged for two-headed drawing; the relationship `kind` becomes the edge
 * label; `sharedTypes` and `acl` ride the edge as metadata. A relation endpoint absent from `contexts`
 * still earns a node, so an edge never points at a missing box. An empty result yields an empty graph.
 */
export function buildContextMapGraph(res: ContextMapResult): ContextMapGraph {
  const seen = new Set<string>();
  const nodes: DiagramNode[] = [];
  // A declared context carries its declaration span (#290); a relation endpoint never declared as a
  // context has no entry in `contextSpans`, so it falls back to null and stays inert to navigation.
  const add = (name: string): void => {
    if (seen.has(name)) return;
    seen.add(name);
    nodes.push(contextNode(name, res.contextSpans?.[name] ?? null));
  };
  for (const c of res.contexts) add(c);
  // Endpoints that were never declared as a context still get a box (the graph never dangles).
  for (const r of res.relations) {
    add(r.upstream);
    add(r.downstream);
  }

  const edges: ContextMapEdge[] = res.relations.map((r) => ({
    from: r.upstream,
    to: r.downstream,
    label: r.kind,
    // A directional relation draws one arrow at the downstream end; a symmetric one draws two heads.
    arrowKind: r.bidirectional ? 'bidirectional' : 'association',
    bidirectional: r.bidirectional,
    sharedTypes: r.sharedTypes,
    acl: r.acl,
  }));

  return { nodes, edges };
}
