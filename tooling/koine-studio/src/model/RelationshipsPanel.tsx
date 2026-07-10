import type { StoreApi } from 'zustand/vanilla';
import type { AppState } from '@/store/index';
import { useAppStore } from '@/store/hooks';
import type { DiagramGraph } from '@/lsp/lsp';
import { extractRelationships, type RelationRow, type TableHandlers } from '@/model/modelTables';
import { SortableTable, type SortableTableColumn } from '@/model/SortableTable';
import { scopeGraph } from '@/model/activeContext';

/** The Relationships table's columns: Source · Relation · Target · Contexts — the tabular view of the
 *  model's structural edges (issue #144). Strategic context→context relations live in the Context Map
 *  facet. */
const RELATIONSHIP_COLUMNS: SortableTableColumn<RelationRow>[] = [
  { header: 'Source', get: (r) => r.source },
  { header: 'Relation', get: (r) => r.relation, cellClass: () => 'koi-rel-kind' },
  { header: 'Target', get: (r) => r.target },
  { header: 'Contexts', get: (r) => r.contexts.join(' → ') },
];

// The bottom-panel Relationships table as a Preact panel (#193, #144, #146): the tabular view of the
// model's STRUCTURAL edges (aggregate→entity composition, references). It subscribes to the
// `activeContext` slice and narrows the structural edges via scopeGraph over the merged diagram graph;
// "All contexts" is the identity. The strategic context→context map is NOT rendered here — its single
// canonical home is the Output → Context Map facet (#146) — so the panel takes only the graph (the
// controller owns the LSP livingDocs fetch under the docViews stale-token discipline). The table renders
// via the shared `SortableTable` (#992 task 3), which re-applies the current sort across a re-render with
// freshly-scoped rows instead of resetting it.
export function RelationshipsPanel(props: {
  store: StoreApi<AppState>;
  graph: DiagramGraph;
  handlers: TableHandlers;
}) {
  const scope = useAppStore(props.store, (s) => s.activeContext);
  const scopedGraph = scopeGraph(props.graph, scope);
  const rows = extractRelationships(scopedGraph);
  return (
    <div class="koi-relationships-mount">
      <SortableTable
        rows={rows}
        columns={RELATIONSHIP_COLUMNS}
        emptyText="No structural relationships yet — add an aggregate or an entity reference to your model."
        rowLabel={(r) => `${r.source} ${r.relation} ${r.target}`}
        // Key rows on the context-qualified edge, not the unqualified label: under "All contexts" two
        // bounded contexts may each declare the same-named pair (e.g. `Order contains OrderItem` in Sales
        // AND in Billing — type names are only unique per context, R13.2). Unique per render: structural
        // rows come from each context's single class diagram, whose builder (DocsEmitter.ContextClassModel)
        // dedupes to ONE edge per source→target pair and dedupes node names within the context.
        rowKey={(r) => `${r.contexts.join('>')}:${r.source}:${r.relation}:${r.target}`}
        handlers={props.handlers}
      />
    </div>
  );
}
