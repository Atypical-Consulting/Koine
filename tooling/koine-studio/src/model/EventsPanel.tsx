import type { StoreApi } from 'zustand/vanilla';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { AppState } from '@/store/index';
import { useAppStore } from '@/store/hooks';
import type { DiagramGraph } from '@/lsp/lsp';
import {
  extractEventFlow,
  extractEvents,
  type EventFlowNode,
  type EventRow,
  type TableHandlers,
} from '@/model/modelTables';
import { SortableTable, type SortableTableColumn } from '@/model/SortableTable';
import { scopeGraph } from '@/model/activeContext';
import { renderEventFlowGraph, type EventFlowGraphHandle } from '@/diagrams/diagrams';

const EM_DASH = '—';

/** The Events table's columns: Event · Type · Published By · Bounded Context · When (issue #144). */
const EVENT_COLUMNS: SortableTableColumn<EventRow>[] = [
  { header: 'Event', get: (r) => r.name },
  {
    header: 'Type',
    get: (r) => (r.type === 'integration' ? 'Integration' : 'Domain'),
    cellClass: (r) => `koi-evt-type koi-evt-${r.type}`,
  },
  { header: 'Published By', get: (r) => r.publishedBy },
  { header: 'Bounded Context', get: (r) => r.context },
  { header: 'When', get: (r) => r.when || EM_DASH },
];

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
        <div class="koi-events-mount">
          <SortableTable
            rows={extractEvents(scopeGraph(props.graph, scope))}
            columns={EVENT_COLUMNS}
            emptyText="No events yet — add a domain or integration event to your model."
            rowLabel={(r) => r.name}
            // Key rows on the QUALIFIED name, not the simple-name label: under "All contexts" two bounded
            // contexts may each declare an event named e.g. `OrderPlaced` (per-context uniqueness, R13.2),
            // and duplicate sibling keys make the focused row land on the WRONG context's event after a sort.
            rowKey={(r) => r.qualifiedName}
            handlers={props.handlers}
            // Clicking an event row also selects it, so the Properties inspector loads it (issue
            // follow-up): the bottom Events table is a list of event nodes; clicking one should inspect
            // it, like the diagram.
            onActivate={(r) => props.handlers.onSelect?.(r.qualifiedName, r.context)}
          />
        </div>
      ) : (
        <EventFlowView graph={props.graph} scope={scope} />
      )}
    </div>
  );
}

// A short human phrase per card kind, for the screen-reader text alternative below.
const KIND_LABEL: Record<EventFlowNode['kind'], string> = {
  command: 'command',
  aggregate: 'aggregate',
  'domain-event': 'domain event',
  policy: 'policy',
  'integration-event': 'integration event',
};

// The Flow view: the event-storming canvas (a maxGraph render, mounted + disposed via an effect so a scope
// change re-derives and re-mounts it) plus a screen-reader text alternative listing the flow's cards — the
// canvas isn't AT-navigable, so the legend is its accessible content (and a stable test target); the
// keyboard-accessible Table view is the alternative for reaching click-to-source. A card click bubbles
// NODE_NAVIGATE_EVENT, which `inspectorController` routes to select-and-goto (like a diagram node) — so the
// navigation wiring lives there, not here.
function EventFlowView(props: { graph: DiagramGraph; scope: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  // Derive the scoped flow ONCE; the memo gives a stable reference, so the mount effect re-runs only when
  // the graph or scope actually changes (not on every parent re-render), and the legend reuses the result.
  const flow = useMemo(() => extractEventFlow(scopeGraph(props.graph, props.scope)), [props.graph, props.scope]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let current = true;
    let handle: EventFlowGraphHandle | null = null;
    void renderEventFlowGraph(host, flow, () => current).then((h) => {
      if (current) handle = h;
      else h?.dispose();
    });
    return () => {
      current = false;
      handle?.dispose();
    };
  }, [flow]);

  return (
    <div class="koi-event-flow">
      {/* The visual canvas — not screen-reader navigable, so it's hidden from AT; the legend is its alt. */}
      <div class="koi-event-flow-mount" ref={hostRef} aria-hidden="true" />
      <ul class="koi-event-flow-legend koi-sr-only" aria-label="Events in this flow">
        {flow.nodes.length === 0 ? (
          <li>No events to chart for this context.</li>
        ) : (
          flow.nodes.map((n) => (
            <li key={n.id}>
              {n.label} — {KIND_LABEL[n.kind]}
              {n.context ? ` in ${n.context}` : ''}
            </li>
          ))
        )}
      </ul>
    </div>
  );
}
