import type { StoreApi } from 'zustand/vanilla';
import type { AppState } from '@/store/index';
import { useAppStore } from '@/store/hooks';
import type { DiagramGraph } from '@/lsp/lsp';
import { extractEvents, renderEventsTable, type TableHandlers } from '@/model/modelTables';
import { scopeGraph } from '@/model/activeContext';

// The bottom-panel Events table as a Preact panel (#193, #144, #146). It subscribes to the `activeContext`
// slice and narrows the merged diagram graph to that bounded context before re-extracting the event rows,
// so switching scope re-renders the table for the active context. The graph itself is passed in — the
// controller owns the LSP fetch (livingDocs) under the docViews stale-token discipline; this panel only
// re-frames it. The table stays the existing pure DOM builder (`renderEventsTable`), mounted through a
// callback ref so the imperative renderer (sortable headers, click-to-source rows) is reused untouched;
// the ref runs on every render with the freshly-scoped rows, so the table tracks the scope.
export function EventsPanel(props: {
  store: StoreApi<AppState>;
  graph: DiagramGraph;
  handlers: TableHandlers;
}) {
  const scope = useAppStore(props.store, (s) => s.activeContext);
  const rows = extractEvents(scopeGraph(props.graph, scope));
  return (
    <div
      class="koi-events-mount"
      ref={(host: HTMLElement | null) => {
        if (!host) return;
        host.replaceChildren(renderEventsTable(rows, props.handlers));
      }}
    />
  );
}
