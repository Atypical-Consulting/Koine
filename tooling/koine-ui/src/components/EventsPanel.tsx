import { useEffect, useRef, useState } from 'preact/hooks';
import { useReadableStore, type ReadableStore } from '../host/store';
import { SortableTable, type SortableTableColumn, type SourceSpan, type TableHandlers } from './SortableTable';

// The bottom-panel Events view as a store-coupled koine-ui component (issue #1408, fourth-tranche
// host-adapter migration; originally Koine Studio's src/model/EventsPanel.tsx — #193/#270): a Table | Flow
// toggle over the model's domain + integration events. Migrated behind a narrow `ReadableStore<
// EventsPanelSlice>` seam — the HOST adapter (`createEventsPanelStore`) pre-scopes the merged diagram graph
// to the active bounded context and pre-extracts both the table rows and the flow legend nodes, so this
// package never sees `DiagramGraph`, `useAppStore`, or the `scopeGraph`/`extractEvents`/`extractEventFlow`
// classifiers. The maxGraph flow CANVAS is heavyweight and canvas-bound, so it stays host-side: the panel
// takes a `renderFlow(host, scopeKey)` callback (a thin wrapper over Koine Studio's `renderEventFlowGraph`)
// and only owns the mount node + the screen-reader legend, exactly like DocsPanelHost captures a mount for
// a host controller. maxGraph never enters koine-ui.

/** The event-storming kinds a flow node can take (Koine Studio's `EventFlowKind`), redeclared plain. */
export type EventFlowKindView = 'command' | 'aggregate' | 'domain-event' | 'policy' | 'integration-event';

/** A plain-primitive mirror of a flow node (Koine Studio's `EventFlowNode`) for the SR-only legend. */
export interface EventFlowNodeView {
  id: string;
  label: string;
  kind: EventFlowKindView;
  context: string;
}

/** A plain-primitive mirror of an events-table row (Koine Studio's `EventRow`), pre-extracted host-side. */
export interface EventRowView {
  name: string;
  qualifiedName: string;
  type: 'domain' | 'integration';
  publishedBy: string;
  context: string;
  when: string;
  span: SourceSpan | null;
}

/** The narrow slice this panel reads: the pre-scoped table rows, the active scope key (which re-frames the
 *  injected flow canvas), and the pre-extracted flow legend nodes. */
export interface EventsPanelSlice {
  rows: EventRowView[];
  scopeKey: string;
  flowNodes: EventFlowNodeView[];
}

/** The host-owned flow renderer: mounts the maxGraph event-flow canvas into `host` for the given scope and
 *  returns a handle whose `dispose()` tears it down. Called on switch-to-flow and re-called on scope change. */
export type FlowRenderer = (host: HTMLElement, scopeKey: string) => { dispose(): void };

const EM_DASH = '—';

const EVENT_COLUMNS: SortableTableColumn<EventRowView>[] = [
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

const KIND_LABEL: Record<EventFlowKindView, string> = {
  command: 'command',
  aggregate: 'aggregate',
  'domain-event': 'domain event',
  policy: 'policy',
  'integration-event': 'integration event',
};

export function EventsPanel(props: {
  store: ReadableStore<EventsPanelSlice>;
  handlers: TableHandlers;
  renderFlow: FlowRenderer;
  initialView?: 'table' | 'flow';
}) {
  // Subscribe for host-notified slice changes (a scope change re-scopes rows + flow nodes host-side)…
  useReadableStore(props.store);
  // …but render from a fresh getState() read, mirroring the DiagnosticsStripPanel precedent.
  const { rows, scopeKey, flowNodes } = props.store.getState();
  const [view, setView] = useState<'table' | 'flow'>(props.initialView ?? 'table');
  return (
    <div class="koi-events-panel">
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
            rows={rows}
            columns={EVENT_COLUMNS}
            emptyText="No events yet — add a domain or integration event to your model."
            rowLabel={(r) => r.name}
            // Key rows on the QUALIFIED event name, not the simple label: Koine allows same-named events in
            // different bounded contexts (per-context uniqueness, R13.2), and "All contexts" renders them in
            // one tbody — a non-unique label key would cross-wire them on a sort (#1382 follow-up).
            rowKey={(r) => r.qualifiedName}
            handlers={props.handlers}
            onActivate={(r) => props.handlers.onSelect?.(r.qualifiedName, r.context)}
          />
        </div>
      ) : (
        <EventFlowView flowNodes={flowNodes} scopeKey={scopeKey} renderFlow={props.renderFlow} />
      )}
    </div>
  );
}

function EventFlowView({ flowNodes, scopeKey, renderFlow }: { flowNodes: EventFlowNodeView[]; scopeKey: string; renderFlow: FlowRenderer }) {
  const hostRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    // The host owns the imperative maxGraph mount; re-frame it whenever the scope key changes, and dispose
    // exactly once on unmount / scope change (the cleanup runs before the next effect and on teardown).
    const handle = renderFlow(host, scopeKey);
    return () => handle.dispose();
  }, [scopeKey, renderFlow]);
  return (
    <div class="koi-event-flow">
      <div class="koi-event-flow-mount" ref={hostRef} aria-hidden="true" />
      <ul class="koi-event-flow-legend koi-sr-only" aria-label="Events in this flow">
        {flowNodes.length === 0 ? (
          <li>No events to chart for this context.</li>
        ) : (
          flowNodes.map((n) => (
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
