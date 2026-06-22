// Active bounded-context scoping (issue #146): the presentation-layer state + pure helpers that let
// Koine Studio narrow its model-derived surfaces (outline, diagram, counts, inspector, the bottom
// Events/Relationships tables) to ONE bounded context, with an "All contexts" option. Scope is a
// filter, never a mutation — every helper here derives a narrowed projection from existing data
// (`DiagramGraph` / `GlossaryModel` / `contextMap()`) and the compiler/LSP/`Ast/` stay untouched.
//
// Deliberately tiny and DOM-free so it unit-tests under happy-dom; the bus mirrors the selection bus
// (selection.ts) so the switcher (ide.ts) and the surfaces subscribe to one source of truth.
import { createStore } from 'zustand/vanilla';
import type { ContextMapResult, DiagramGraph, DocsFile, GlossaryModel } from './lsp';
import { createActiveContextSlice, type ActiveContextSlice } from './store/slices/activeContext';

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

/**
 * Narrow the living-docs files behind the Diagrams tab to a single bounded context: each diagram's
 * structured graph is scoped (the renderer draws from `diagram.graph`), diagrams left with no nodes are
 * dropped, and files left with no diagrams fall away — so a context with no diagram simply shows the
 * empty state. {@link ALL_CONTEXTS} is the identity — the same files are returned untouched.
 */
export function scopeDocsFiles(files: DocsFile[], scope: ContextScope): DocsFile[] {
  if (isAllContexts(scope)) return files;
  return files
    .map((f) => ({
      ...f,
      diagrams: f.diagrams
        .map((d) => ({ ...d, graph: scopeGraph(d.graph, scope) }))
        .filter((d) => d.graph.nodes.length > 0),
    }))
    .filter((f) => f.diagrams.length > 0);
}

/**
 * The scope the context switcher should follow to when the active file changes — the file-explorer
 * counterpart of the selection-follow. A `.koi` file names its bounded context(s) as its top-level
 * document symbols (the language service emits one per `context`), so {@link fileContexts} is that
 * list and its first entry is the file's primary context. Returns that context so the top bar tracks
 * the file you opened — overriding {@link ALL_CONTEXTS}, since opening a file is navigation into it
 * (unlike a read-only inspect, which leaves the overview intact). Returns undefined to leave the
 * scope untouched: when the file declares no context (empty/unparseable → no symbols) or its primary
 * context already matches the active scope (idempotent — no churn).
 */
export function fileContextFollow(fileContexts: readonly string[], scope: ContextScope): string | undefined {
  const context = fileContexts[0];
  if (!context || context === scope) return undefined;
  return context;
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

/**
 * Creates an independent active-context bus, defaulting to {@link ALL_CONTEXTS}, backed by a private
 * Zustand store (transition adapter). The "same value in = no churn" contract lives in the slice's
 * setActiveContext, so re-selecting the active scope never notifies the surfaces.
 */
export function createActiveContextBus(initial: ContextScope = ALL_CONTEXTS): ActiveContextBus {
  const store = createStore<ActiveContextSlice>((set, get) => createActiveContextSlice(set, get));
  if (initial !== ALL_CONTEXTS) store.getState().setActiveContext(initial);
  return {
    get: () => store.getState().activeContext,
    set: (scope) => store.getState().setActiveContext(scope),
    subscribe: (fn) =>
      store.subscribe((s, prev) => {
        if (s.activeContext !== prev.activeContext) fn(s.activeContext);
      }),
  };
}
