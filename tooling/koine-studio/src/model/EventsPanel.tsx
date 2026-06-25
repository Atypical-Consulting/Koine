import type { StoreApi } from 'zustand/vanilla';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { AppState } from '@/store/index';
import { useAppStore } from '@/store/hooks';
import type { DiagramGraph } from '@/lsp/lsp';
import { extractEventFlow, extractEvents, renderEventsTable, type TableHandlers } from '@/model/modelTables';
import { scopeGraph } from '@/model/activeContext';
import { renderEventFlowGraph, type EventFlowGraphHandle } from '@/diagrams/diagrams';

// The bottom-panel Events view as a Preact panel (#193, #144, #146, #270). It subscribes to the
// `activeContext` slice and narrows the merged diagram graph to that bounded context, then renders it two
// ways behind a Table | Flow toggle (#270): the existing scannable table, or a model-derived event-storming
// FLOW canvas (command → event → policy, plus cross-context publish/subscribe). Both read the SAME scoped
// graph — switching scope re-frames whichever view is shown — and the graph is passed in (the controller
// owns the LSP fetch). No compiler/LSP round trip is added; the Flow view consumes `extractEventFlow`.
export function EventsPanel(props: {
  store: StoreApi<AppState>;
  graph: DiagramGraph;
  handlers: TableHandlers;
  /** Which view to open in; defaults to the table. Lets a story / caller open straight to the flow. */
  initialView?: 'table' | 'flow';
}) {
  const scope = useAppStore(props.store, (s) => s.activeContext);
  const [view, setView] = useState<'table' | 'flow'>(props.initialView ?? 'table');
  return (
    <div class="koi-events-panel">
      {/* A toggle-button group (aria-pressed), not tabs — the two views share one panel region. */}
      <div class="koi-events-toolbar" role="group" aria-label="Events view">
        <button
          type="button"
          class="koi-events-view-btn"
          data-view="table"
          aria-pressed={view === 'table'}
          onClick={() => setView('table')}
        >
          Table
        </button>
        <button
          type="button"
          class="koi-events-view-btn"
          data-view="flow"
          aria-pressed={view === 'flow'}
          onClick={() => setView('flow')}
        >
          Flow
        </button>
      </div>
      {view === 'table' ? (
        // The table stays the existing pure DOM builder, mounted through a callback ref so the imperative
        // renderer (sortable headers, click-to-source rows) is reused untouched; it re-runs on every render
        // with the freshly-scoped rows, so the table tracks the scope.
        <div
          class="koi-events-mount"
          ref={(host: HTMLElement | null) => {
            if (!host) return;
            host.replaceChildren(renderEventsTable(extractEvents(scopeGraph(props.graph, scope)), props.handlers));
          }}
        />
      ) : (
        <EventFlowView graph={props.graph} scope={scope} />
      )}
    </div>
  );
}

// The Flow view: the event-storming canvas (a maxGraph render, mounted + disposed via an effect so a scope
// change re-derives and re-mounts it) plus a screen-reader text alternative listing the flow's cards — the
// canvas isn't AT-navigable, so the legend is its accessible content (and a stable test target). A card
// click bubbles NODE_NAVIGATE_EVENT, which `inspectorController` routes to select-and-goto (like a diagram
// node) — so the navigation wiring lives there, not here.
function EventFlowView(props: { graph: DiagramGraph; scope: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const flow = extractEventFlow(scopeGraph(props.graph, props.scope));

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let current = true;
    let handle: EventFlowGraphHandle | null = null;
    // Re-derive inside the effect so the dependency list is the stable (graph, scope) pair, not the
    // freshly-built flow object (which changes identity every render).
    const scoped = extractEventFlow(scopeGraph(props.graph, props.scope));
    void renderEventFlowGraph(host, scoped, () => current).then((h) => {
      if (current) handle = h;
      else h?.dispose();
    });
    return () => {
      current = false;
      handle?.dispose();
    };
  }, [props.graph, props.scope]);

  return (
    <div class="koi-event-flow">
      {/* The visual canvas — not screen-reader navigable, so it's hidden from AT; the legend is its alt. */}
      <div class="koi-event-flow-mount" ref={hostRef} aria-hidden="true" />
      <ul class="koi-event-flow-legend koi-sr-only" aria-label="Events in this flow">
        {flow.nodes.length === 0 ? (
          <li>No events to chart for this context.</li>
        ) : (
          flow.nodes.map((n) => <li key={n.id}>{n.label}</li>)
        )}
      </ul>
    </div>
  );
}
