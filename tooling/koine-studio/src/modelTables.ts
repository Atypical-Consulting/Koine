// Events & Relationships tables for Studio's bottom panel (issue #144): a flat, scannable view of
// "what events exist, who publishes them, in which context" and "how do these elements relate",
// complementing the node-and-edge diagram. Pure extractors (this half) + pure DOM renderers (below,
// Task 2), decoupled from the LSP/editor so they unit-test under happy-dom — mirrors `modelOutline.ts`.
//
// Source of truth: the SAME source-aware `DiagramGraph` projection that drives the diagram (issue #93)
// plus the strategic `contextMap()` relations — so the tables and the diagram never drift. No compiler
// /LSP/`Ast/` change: events are the graph's `event` / `integration-event` nodes, structural relations
// are its composition edges, strategic relations come from the context map.
import type { ContextMapResult, DiagramEdge, DiagramGraph, DiagramNode, SourceSpan } from './lsp';

/** One row of the Events table. `when` is the event's description (see note in extractEvents). */
export interface EventRow {
  name: string;
  type: 'domain' | 'integration';
  /** The owning aggregate root (domain events) or publishing context (integration events); '—' if unknown. */
  publishedBy: string;
  /** The bounded context the event belongs to. */
  context: string;
  /** Description / "When" — empty until a `DiagramNode.doc` field lands on the wire (see PR note). */
  when: string;
  /** Jump-to-source target; null only when the node truly has no position. */
  span: SourceSpan | null;
}

/** One row of the Relationships table: `source` —relation→ `target`, spanning `contexts`. */
export interface RelationRow {
  source: string;
  /** 'contains' for an aggregate composition edge, else the edge label or the strategic relation kind. */
  relation: string;
  target: string;
  /** The context(s) the relation spans — one for a structural edge, two for a strategic relation. */
  contexts: string[];
  /** Jump-to-source target; null for strategic relations (the context map carries no span). */
  span: SourceSpan | null;
}

/** The diagram node kinds that draw as a UML class box — the endpoints of a structural relationship. */
const CLASS_KINDS = new Set(['aggregate-root', 'entity', 'value-object', 'enum', 'event']);

/** The bounded context of a `Context.Name` qualified name (everything before the first dot). */
function contextOf(qualifiedName: string): string {
  const dot = qualifiedName.indexOf('.');
  return dot < 0 ? '' : qualifiedName.slice(0, dot);
}

/** The simple name of a `Context.Name` qualified name (everything after the first dot). */
function simpleNameOf(qualifiedName: string): string {
  const dot = qualifiedName.indexOf('.');
  return dot < 0 ? qualifiedName : qualifiedName.slice(dot + 1);
}

/**
 * Fuse several per-diagram graphs into one projection for the extractors. Node ids are only unique
 * *within* their owning graph (issue #93), so a naive concat could cross-link edges between two nodes
 * that share an id (e.g. a `context` node appearing in both the context-map and integration-event
 * graphs). Each graph's ids — and its edges' endpoints — are namespaced by the graph's index, keeping
 * every edge resolving to the right node while making ids globally unique. Labels/qualified names are
 * untouched (the tables display those, never the id).
 */
export function mergeDiagramGraphs(graphs: DiagramGraph[]): DiagramGraph {
  const nodes: DiagramNode[] = [];
  const edges: DiagramEdge[] = [];
  graphs.forEach((graph, i) => {
    const prefix = `g${i}:`;
    for (const n of graph.nodes) {
      nodes.push({ ...n, id: prefix + n.id });
    }
    for (const e of graph.edges) {
      edges.push({ ...e, from: prefix + e.from, to: prefix + e.to });
    }
  });
  return { nodes, edges };
}

/**
 * The events in the (merged) graph: every `event` (domain) and `integration-event` node, classified by
 * type, with its publisher resolved from the graph's edges — a domain event's owning aggregate root
 * (the composition edge pointing at it) or an integration event's publishing context (the `publishes`
 * edge). Missing publishers default to '—'. `when` is left empty: the event's `///` description isn't on
 * the diagram wire today, so populating it cleanly needs a one-line `DiagramNode.doc` field (deferred to
 * keep this change free of compiler/LSP edits — see the PR note).
 */
export function extractEvents(graph: DiagramGraph): EventRow[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n] as const));
  const rows: EventRow[] = [];
  for (const node of graph.nodes) {
    if (node.kind !== 'event' && node.kind !== 'integration-event') {
      continue;
    }
    rows.push({
      name: simpleNameOf(node.qualifiedName),
      type: node.kind === 'integration-event' ? 'integration' : 'domain',
      publishedBy: publisherOf(node, graph.edges, byId),
      context: contextOf(node.qualifiedName),
      when: '',
      span: node.sourceSpan,
    });
  }
  return rows;
}

/** The label of the node that publishes `event`: the `publishes` edge's source (integration) or the lone composition edge's source (domain). */
function publisherOf(event: DiagramNode, edges: DiagramEdge[], byId: Map<string, DiagramNode>): string {
  const incoming = edges.filter((e) => e.to === event.id);
  const publisher = incoming.find((e) => e.label === 'publishes') ?? incoming[0];
  return (publisher && byId.get(publisher.from)?.label) || '—';
}

/**
 * The relationships in the (merged) graph plus the strategic context map: structural relations are the
 * composition edges between two class nodes (`Order` —contains→ `OrderItem`); a null edge label reads as
 * 'contains'. Event-flow edges (`publishes` / `consumed by`), state-machine transitions and context-map
 * edges are skipped here — they aren't endpoint-to-endpoint structural links. Strategic relations come
 * from `contextMap.relations` (`upstream` —kind→ `downstream`), which carry no source span.
 */
export function extractRelationships(graph: DiagramGraph, contextMap: ContextMapResult): RelationRow[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n] as const));
  const rows: RelationRow[] = [];

  for (const e of graph.edges) {
    const from = byId.get(e.from);
    const to = byId.get(e.to);
    if (!from || !to || !CLASS_KINDS.has(from.kind) || !CLASS_KINDS.has(to.kind)) {
      continue;
    }
    rows.push({
      source: from.label,
      relation: e.label ?? 'contains',
      target: to.label,
      contexts: [contextOf(from.qualifiedName)],
      span: from.sourceSpan ?? to.sourceSpan,
    });
  }

  for (const rel of contextMap.relations) {
    rows.push({
      source: rel.upstream,
      relation: rel.kind,
      target: rel.downstream,
      contexts: [rel.upstream, rel.downstream],
      span: null,
    });
  }

  return rows;
}
