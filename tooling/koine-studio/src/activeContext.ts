// Active bounded-context scoping (issue #146): the presentation-layer state + pure helpers that let
// Koine Studio narrow its model-derived surfaces (outline, diagram, counts, inspector, the bottom
// Events/Relationships tables) to ONE bounded context, with an "All contexts" option. Scope is a
// filter, never a mutation — every helper here derives a narrowed projection from existing data
// (`DiagramGraph` / `GlossaryModel` / `contextMap()`) and the compiler/LSP/`Ast/` stay untouched.
//
// Deliberately tiny and DOM-free so it unit-tests under happy-dom; the bus mirrors the selection bus
// (selection.ts) so the switcher (ide.ts) and the surfaces subscribe to one source of truth.
import type { ContextMapResult, DiagramGraph, GlossaryModel } from './lsp';

/** The sentinel scope meaning "don't narrow — show every context". A real context name never collides
 *  (Koine contexts are PascalCase identifiers), so this lowercase literal is safe as the unscoped marker. */
export const ALL_CONTEXTS = 'all';

/** The active scope: a bounded-context name, or {@link ALL_CONTEXTS} for the unscoped view. */
export type ContextScope = string;

/** True for the unscoped sentinel — the one place that decision is made, so every helper agrees. */
export function isAllContexts(scope: ContextScope): boolean {
  return scope === ALL_CONTEXTS;
}

/**
 * The bounded context a qualified name belongs to: the segment before the first dot (`Sales.Order` →
 * `Sales`), or the whole name when there's no dot (a context node keyed by its own bare name).
 */
function contextOf(qualifiedName: string): string {
  const dot = qualifiedName.indexOf('.');
  return dot < 0 ? qualifiedName : qualifiedName.slice(0, dot);
}

/**
 * The distinct bounded contexts named by a model projection, in first-seen order with blanks dropped.
 * Accepts whichever source a caller already holds — a strategic {@link ContextMapResult} (its
 * `contexts` list verbatim), a {@link DiagramGraph} (each node's context prefix), or a
 * {@link GlossaryModel} (each entry's `context`) — so the switcher can populate from any of them.
 */
export function listContexts(source: DiagramGraph | ContextMapResult | GlossaryModel): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (raw: string): void => {
    const ctx = raw.trim();
    if (ctx && !seen.has(ctx)) {
      seen.add(ctx);
      out.push(ctx);
    }
  };

  if ('contexts' in source) {
    for (const c of source.contexts) add(c);
  } else if ('nodes' in source) {
    for (const n of source.nodes) add(contextOf(n.qualifiedName));
  } else {
    for (const e of source.entries) add(e.context);
  }
  return out;
}

/**
 * Narrow a {@link DiagramGraph} to a single bounded context: keep the nodes whose context matches and
 * the edges whose BOTH endpoints survive (so a cross-context edge to a filtered-out node is dropped,
 * never left dangling). {@link ALL_CONTEXTS} is the identity — the same graph is returned untouched.
 */
export function scopeGraph(graph: DiagramGraph, scope: ContextScope): DiagramGraph {
  if (isAllContexts(scope)) return graph;
  const nodes = graph.nodes.filter((n) => contextOf(n.qualifiedName) === scope);
  const keep = new Set(nodes.map((n) => n.id));
  const edges = graph.edges.filter((e) => keep.has(e.from) && keep.has(e.to));
  return { nodes, edges };
}

/**
 * Narrow a {@link GlossaryModel} (the outline/counts backbone) to a single bounded context by keeping
 * only that context's entries. {@link ALL_CONTEXTS} is the identity — the same model is returned.
 */
export function scopeGlossaryModel(model: GlossaryModel, scope: ContextScope): GlossaryModel {
  if (isAllContexts(scope)) return model;
  return { entries: model.entries.filter((e) => e.context === scope) };
}

/** A minimal observable holding the active scope; the switcher writes it, the surfaces subscribe. */
export interface ActiveContextBus {
  /** The current scope (a context name, or {@link ALL_CONTEXTS}). */
  get(): ContextScope;
  /** Set the scope; notifies subscribers only on a real change (same value in = no churn). */
  set(scope: ContextScope): void;
  /** Subscribe to scope changes; returns an unsubscribe handle. */
  subscribe(fn: (scope: ContextScope) => void): () => void;
}

/** Creates an independent active-context bus, defaulting to {@link ALL_CONTEXTS}. */
export function createActiveContextBus(initial: ContextScope = ALL_CONTEXTS): ActiveContextBus {
  let current: ContextScope = initial;
  const subscribers = new Set<(scope: ContextScope) => void>();

  return {
    get: () => current,
    set(scope) {
      // Re-selecting the active scope is a no-op: the switcher repaints idempotently and an edit can
      // re-assert the restored scope, so an unconditional notify would re-render the surfaces for nothing.
      if (scope === current) return;
      current = scope;
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
