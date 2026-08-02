// Events & Relationships tables for Studio's bottom panel (issue #144): a flat, scannable view of
// "what events exist, who publishes them, in which context" and "how do these elements relate",
// complementing the node-and-edge diagram. Pure extractors, decoupled from the LSP/editor so they
// unit-test under happy-dom — mirrors `modelOutline.ts`. This module used to also hold the DOM-builder
// renderers that painted the tables; #992 task 3 retired them in favor of the shared `SortableTable`
// Preact component (see the `TableHandlers` note at the bottom of this file).
//
// Source of truth: the SAME source-aware `DiagramGraph` projection that drives the diagram (issue #93) —
// so the tables are a tabular view of the model the Canvas draws, and never drift from it. The
// Relationships table shows STRUCTURAL edges only; the strategic context→context map has one canonical
// home, the Output → Context Map facet (#146), and is not re-rendered here. No compiler/LSP/`Ast/`
// change: events are the graph's `event` / `integration-event` nodes, structural relations are its
// composition edges.
import type { DiagramEdge, DiagramGraph, DiagramNode, SourceSpan } from '@/lsp/lsp';

/** One row of the Events table. `when` is the event's description (see note in extractEvents). */
export interface EventRow {
  name: string;
  /** The event's qualified name — the key the inspector resolves when a row is clicked to select it. */
  qualifiedName: string;
  type: 'domain' | 'integration';
  /** The owning aggregate root (domain events) or publishing context (integration events); '—' if unknown. */
  publishedBy: string;
  /** The bounded context the event belongs to. */
  context: string;
  /** Description / "When": the event's `///` doc, from `DiagramNode.doc` (issue #170); '' when undocumented. */
  when: string;
  /** Jump-to-source target; null only when the node truly has no position. */
  span: SourceSpan | null;
}

/** An event-storming card kind for the Event Flow canvas (#270). `command` / `policy` are part of the
 *  vocabulary so the renderer can draw them, but aren't derived from today's graph (the compiler emits no
 *  command / policy graph nodes yet — a follow-up enriches the emitted graph; see issue #270). */
export type EventFlowKind = 'command' | 'aggregate' | 'domain-event' | 'policy' | 'integration-event';

/** One card in the event-storming flow: an event, its publishing aggregate, or (future) a command/policy. */
export interface EventFlowNode {
  /** The graph node id this card came from — the key edge endpoints reference. */
  id: string;
  /** The simple display name (e.g. `OrderPlaced`), not the qualified name. */
  label: string;
  kind: EventFlowKind;
  /** The dotted stable name (`Sales.OrderPlaced`); the key the inspector resolves on click. */
  qualifiedName: string;
  /** The bounding context the card belongs to. */
  context: string;
  /** Jump-to-source target; null only when the node truly has no position. */
  span: SourceSpan | null;
}

/** One arrow in the flow: an aggregate→event `flow`, or a context↔integration-event `publish`/`subscribe`.
 *  `publish`/`subscribe` endpoints that aren't card ids are bounded-context names — the renderer draws those
 *  as swimlanes, not cards. */
export interface EventFlowEdge {
  from: string;
  to: string;
  label: string | null;
  kind: 'flow' | 'publish' | 'subscribe';
}

/** One row of the Relationships table: `source` —relation→ `target`, within its bounded `contexts`. */
export interface RelationRow {
  source: string;
  /** 'contains' for an aggregate composition edge, else the edge label (e.g. a reference). */
  relation: string;
  target: string;
  /** The bounded context the structural relation lives in (a single-element list). */
  contexts: string[];
  /** Jump-to-source target; null only when neither endpoint carries a source span. */
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
 * Fuse several per-diagram graphs into ONE graph for a single, unified diagram (the visual editor's "one
 * big diagram"). Unlike {@link mergeDiagramGraphs} — which namespaces every id so the tables can treat
 * each per-diagram graph as distinct — this DEDUPES shared elements: a node that appears in more than one
 * diagram (e.g. an entity drawn both in its aggregate and in its state machine) collapses to a single
 * node, keeping the richest representation (most member rows / a stereotype). Edges are remapped to the
 * surviving node ids, with self-loops and duplicates dropped, so each concept and relationship is drawn
 * once. Nodes without a dotted qualified name (contexts, states) stay per-graph (namespaced) so distinct
 * states never collapse together.
 */
export function mergeGraphsForView(graphs: DiagramGraph[]): DiagramGraph {
  const keyOf = (graphIdx: number, n: DiagramNode): string =>
    n.qualifiedName && n.qualifiedName.includes('.') ? n.qualifiedName : `g${graphIdx}:${n.id}`;
  const richness = (n: DiagramNode): number => (n.members?.length ?? 0) + (n.stereotype ? 1 : 0);

  const nodeByKey = new Map<string, DiagramNode>();
  const idToKey = new Map<string, string>(); // namespaced local id (`g{i}:{id}`) → canonical key
  graphs.forEach((graph, i) => {
    for (const n of graph.nodes) {
      const key = keyOf(i, n);
      idToKey.set(`g${i}:${n.id}`, key);
      const existing = nodeByKey.get(key);
      if (!existing || richness(n) > richness(existing)) nodeByKey.set(key, { ...n, id: key });
    }
  });

  const seen = new Set<string>();
  const edges: DiagramEdge[] = [];
  graphs.forEach((graph, i) => {
    for (const e of graph.edges) {
      const from = idToKey.get(`g${i}:${e.from}`);
      const to = idToKey.get(`g${i}:${e.to}`);
      if (!from || !to || from === to) continue;
      const sig = `${from} ${to} ${e.label ?? ''}`;
      if (seen.has(sig)) continue;
      seen.add(sig);
      // Spread the source edge so every wire field (cardinality, sourceCardinality, arrowKind,
      // backingMember) survives the merge; only the endpoints are remapped to the canonical node keys.
      edges.push({ ...e, from, to });
    }
  });

  return { nodes: [...nodeByKey.values()], edges };
}

/**
 * The events in the (merged) graph: every `event` (domain) and `integration-event` node, classified by
 * type, with its publisher resolved from the graph's edges — a domain event's owning aggregate root
 * (the composition edge pointing at it) or an integration event's publishing context (the `publishes`
 * edge). Missing publishers default to '—'. `when` is the event's `///` description, carried on the wire
 * as `DiagramNode.doc` (issue #170); '' when the event is undocumented (the renderer shows '—').
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
      qualifiedName: node.qualifiedName,
      type: node.kind === 'integration-event' ? 'integration' : 'domain',
      publishedBy: publisherOf(node, graph.edges, byId),
      context: contextOf(node.qualifiedName),
      when: node.doc ?? '',
      span: node.sourceSpan,
    });
  }
  return rows;
}

/** The node that publishes `event`: the `publishes` edge's source (integration — a context) or the lone
 *  composition edge's source (domain — the owning aggregate). Undefined when the event has no publisher.
 *  A `command --emits--> event` chain edge (issue #439) is the event's PRODUCER, not its owning aggregate /
 *  publishing context, so command/policy sources are excluded here — the publisher stays the aggregate or
 *  context, and the command appears via the event-flow chain instead. */
function publisherNodeOf(event: DiagramNode, edges: DiagramEdge[], byId: Map<string, DiagramNode>): DiagramNode | undefined {
  const incoming = edges.filter((e) => {
    if (e.to !== event.id) return false;
    const from = byId.get(e.from);
    return !from || (from.kind !== 'command' && from.kind !== 'policy');
  });
  const publisher = incoming.find((e) => e.label === 'publishes') ?? incoming[0];
  return publisher ? byId.get(publisher.from) : undefined;
}

/** The label of the node that publishes `event`, or an em dash when none. */
function publisherOf(event: DiagramNode, edges: DiagramEdge[], byId: Map<string, DiagramNode>): string {
  return publisherNodeOf(event, edges, byId)?.label || '—';
}

/**
 * Derive the event-storming flow from the (merged) graph (#270, #439): every domain `event` becomes a
 * `domain-event` card with a `flow` edge from its publishing aggregate, every `integration-event`
 * becomes an `integration-event` card with a `publish` edge FROM its publishing context and a `subscribe`
 * edge TO the consuming context — the publish/subscribe arrows that bridge bounded contexts — and every
 * `command` / `policy` node becomes its card, wired into the events by the chain edges
 * `command --emits--> event --triggers--> policy --issues--> command` (#439). An event/command/policy with
 * no wiring still yields its card (an orphan), so the canvas is never emptier than the Events table. No
 * compiler round trip: this consumes the SAME graph the table does (via `publisherNodeOf`, the
 * `extractEvents` publisher rule), so the flow and the table never drift. Contexts are NOT cards: a
 * publish/subscribe endpoint is the context node's id, drawn as a swimlane.
 */
export function extractEventFlow(graph: DiagramGraph): { nodes: EventFlowNode[]; edges: EventFlowEdge[] } {
  const byId = new Map(graph.nodes.map((n) => [n.id, n] as const));
  const nodes: EventFlowNode[] = [];
  const edges: EventFlowEdge[] = [];
  const seen = new Set<string>();
  // Card id → its flow kind, so the chain pass can tell which graph edges connect two cards.
  const cardKind = new Map<string, EventFlowKind>();

  const addNode = (n: EventFlowNode): void => {
    if (seen.has(n.id)) return;
    seen.add(n.id);
    cardKind.set(n.id, n.kind);
    nodes.push(n);
  };

  const cardOf = (node: DiagramNode, kind: EventFlowKind): EventFlowNode => ({
    id: node.id,
    label: simpleNameOf(node.qualifiedName),
    kind,
    qualifiedName: node.qualifiedName,
    context: contextOf(node.qualifiedName),
    span: node.sourceSpan,
  });

  for (const node of graph.nodes) {
    if (node.kind !== 'event' && node.kind !== 'integration-event') {
      continue;
    }
    const integration = node.kind === 'integration-event';
    addNode(cardOf(node, integration ? 'integration-event' : 'domain-event'));

    const publisher = publisherNodeOf(node, graph.edges, byId);
    if (!publisher) {
      continue; // an orphan event — the card stands alone (the canvas is never emptier than the table)
    }

    if (integration) {
      // The publisher of an integration event is its bounded CONTEXT — a publish arrow from that swimlane.
      edges.push({ from: publisher.id, to: node.id, label: 'publishes', kind: 'publish' });
      const subscriber = graph.edges.find((e) => e.from === node.id && e.label === 'consumed by');
      if (subscriber) {
        edges.push({ from: node.id, to: subscriber.to, label: 'consumed by', kind: 'subscribe' });
      }
    } else {
      // The publisher of a domain event is its owning AGGREGATE — a flow arrow from that card.
      addNode(cardOf(publisher, 'aggregate'));
      edges.push({ from: publisher.id, to: node.id, label: null, kind: 'flow' });
    }
  }

  // Command + policy cards (#439): the producers and reactors of the chain. Emitted even when unwired (an
  // orphan command/policy), mirroring orphan events. `command` / `policy` are already EventFlowKinds. The
  // card text is the bare behavior/policy name (`node.label`, e.g. `capture`) — NOT `simpleNameOf`, which on
  // a `Context.Entity.command` qualified name would keep the owning entity (`Charge.capture`).
  for (const node of graph.nodes) {
    if (node.kind === 'command' || node.kind === 'policy') {
      addNode({ ...cardOf(node, node.kind), label: node.label });
    }
  }

  // The chain edges command --emits--> event --triggers--> policy --issues--> command (#439): a graph edge
  // is part of the chain when EITHER endpoint is a command/policy card. That excludes the aggregate→event
  // composition and the context publish/subscribe arrows (handled above), avoiding duplicate edges. Both
  // endpoints must be cards (a cross-context emit/react whose other end isn't drawn here is skipped).
  for (const e of graph.edges) {
    const fromKind = cardKind.get(e.from);
    const toKind = cardKind.get(e.to);
    if (!fromKind || !toKind) continue;
    const isChain =
      fromKind === 'command' || fromKind === 'policy' || toKind === 'command' || toKind === 'policy';
    if (isChain) {
      edges.push({ from: e.from, to: e.to, label: e.label, kind: 'flow' });
    }
  }

  return { nodes, edges };
}

/**
 * The STRUCTURAL relationships in the (merged) graph: the composition edges between two class nodes
 * (`Order` —contains→ `OrderItem`); a null edge label reads as 'contains'. Event-flow edges (`publishes`
 * / `consumed by`), state-machine transitions and context-map edges are skipped here — they aren't
 * endpoint-to-endpoint structural links. Strategic context→context relations are deliberately NOT
 * emitted: their single canonical home is the Output → Context Map facet (graph + table), so the
 * Relationships table stays the tabular view of the model's structural edges and never double-renders the
 * strategic map (#146).
 */
export function extractRelationships(graph: DiagramGraph): RelationRow[] {
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

  return rows;
}

// --- table handlers contract ---------------------------------------------------------------------
// The DOM-builder renderers that used to live here (`renderTable`/`buildRow`/`renderEventsTable`/
// `renderRelationshipsTable`) were retired in #992 task 3: EventsPanel/RelationshipsPanel now render
// their rows through the shared `SortableTable` component (`@/model/SortableTable`). This contract —
// the editor side-effects a table needs — is the only piece those panels still import from here.

/** The editor side-effects a table needs: jump the caret to a construct's declaration span, and
 * (optionally) select an element so the Properties inspector loads it — the Events table wires this
 * so clicking an event row inspects it, mirroring a diagram-node click. */
export interface TableHandlers {
  goto: (span: SourceSpan) => void;
  onSelect?: (qualifiedName: string, context: string) => void;
}
