import type { StoreApi } from 'zustand/vanilla';
import type { AppState } from '@/store/index';
import { useAppStore } from '@/store/hooks';
import type { ContextMapResult, DiagramGraph } from '@/lsp/lsp';
import { extractRelationships, renderRelationshipsTable, type TableHandlers } from '@/model/modelTables';
import { scopeContextMap, scopeGraph } from '@/model/activeContext';

// The bottom-panel Relationships table as a Preact panel (#193, #144, #146). It subscribes to the
// `activeContext` slice and narrows BOTH halves of the relationships view: the structural edges (via
// scopeGraph over the merged diagram graph) and the strategic context-map relations (kept only when the
// active context is one of their endpoints — exactly the controller's old loadRelationshipsPanel filter).
// "All contexts" is the identity. The graph + context map are passed in — the controller owns the LSP
// fetch (livingDocs + contextMap) under the docViews stale-token discipline. The table stays the existing
// pure DOM builder (`renderRelationshipsTable`), mounted through a callback ref so the imperative renderer
// (sortable headers, click-to-source rows) is reused untouched; it re-runs on every render with the
// freshly-scoped rows, so the table tracks the scope.
export function RelationshipsPanel(props: {
  store: StoreApi<AppState>;
  graph: DiagramGraph;
  contextMap: ContextMapResult;
  handlers: TableHandlers;
}) {
  const scope = useAppStore(props.store, (s) => s.activeContext);
  const scopedGraph = scopeGraph(props.graph, scope);
  const scopedCtxMap = scopeContextMap(props.contextMap, scope);
  const rows = extractRelationships(scopedGraph, scopedCtxMap);
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
