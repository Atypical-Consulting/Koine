import type { StoreApi } from 'zustand/vanilla';
import type { AppState } from '@/store/index';
import { useAppStore } from '@/store/hooks';
import type { DiagramGraph } from '@/lsp/lsp';
import { extractRelationships, renderRelationshipsTable, type TableHandlers } from '@/model/modelTables';
import { scopeGraph } from '@/model/activeContext';

// The bottom-panel Relationships table as a Preact panel (#193, #144, #146): the tabular view of the
// model's STRUCTURAL edges (aggregate→entity composition, references). It subscribes to the
// `activeContext` slice and narrows the structural edges via scopeGraph over the merged diagram graph;
// "All contexts" is the identity. The strategic context→context map is NOT rendered here — its single
// canonical home is the Output → Context Map facet (#146) — so the panel takes only the graph (the
// controller owns the LSP livingDocs fetch under the docViews stale-token discipline). The table stays
// the existing pure DOM builder (`renderRelationshipsTable`), mounted through a callback ref so the
// imperative renderer (sortable headers, click-to-source rows) is reused untouched; it re-runs on every
// render with the freshly-scoped rows, so the table tracks the scope.
export function RelationshipsPanel(props: {
  store: StoreApi<AppState>;
  graph: DiagramGraph;
  handlers: TableHandlers;
}) {
  const scope = useAppStore(props.store, (s) => s.activeContext);
  const scopedGraph = scopeGraph(props.graph, scope);
  const rows = extractRelationships(scopedGraph);
  return (
    <div
      class="koi-relationships-mount"
      ref={(host: HTMLElement | null) => {
        if (!host) return;
        host.replaceChildren(renderRelationshipsTable(rows, props.handlers));
      }}
    />
  );
}
