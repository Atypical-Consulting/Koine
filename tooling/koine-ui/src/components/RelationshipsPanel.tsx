import { useReadableStore, type ReadableStore } from '../host/store';
import { SortableTable, type SortableTableColumn, type SourceSpan, type TableHandlers } from './SortableTable';

// The bottom-panel Relationships table as a store-coupled koine-ui component (issue #1408, fourth-tranche
// host-adapter migration; originally Koine Studio's src/model/RelationshipsPanel.tsx — #193/#144/#146):
// the tabular view of the model's STRUCTURAL edges (aggregate→entity composition, references). Migrated
// behind a narrow `ReadableStore<RelationshipsPanelSlice>` seam so a non-IDE consumer can render it — the
// HOST adapter (Koine Studio's `createRelationshipsPanelStore`) pre-scopes the merged diagram graph to the
// active bounded context and pre-extracts the rows, so this package never sees `DiagramGraph`, `useAppStore`,
// or `scopeGraph`/`extractRelationships` (they stay in their owning Studio modules). The strategic
// context→context map is NOT rendered here — its single canonical home is the Output → Context Map facet
// (#146). The table renders via the shared `SortableTable` (#992 task 3), which re-applies the current sort
// across a re-render with freshly-scoped rows instead of resetting it.

/** A plain-primitive mirror of a structural relation row (Koine Studio's `RelationRow`), pre-computed by
 *  the host adapter's selector. Row/view types are declared beside the slice per the host-adapter recipe so
 *  koine-ui never imports a Koine Studio / LSP type. */
export interface RelationRowView {
  source: string;
  relation: string;
  target: string;
  contexts: string[];
  span: SourceSpan | null;
}

/** The narrow slice this panel reads: the pre-scoped + pre-extracted structural relation rows. */
export interface RelationshipsPanelSlice {
  rows: RelationRowView[];
}

/** The Relationships table's columns: Source · Relation · Target · Contexts — the tabular view of the
 *  model's structural edges (issue #144). Strategic context→context relations live in the Context Map
 *  facet. */
const RELATIONSHIP_COLUMNS: SortableTableColumn<RelationRowView>[] = [
  { header: 'Source', get: (r) => r.source },
  { header: 'Relation', get: (r) => r.relation, cellClass: () => 'koi-rel-kind' },
  { header: 'Target', get: (r) => r.target },
  { header: 'Contexts', get: (r) => r.contexts.join(' → ') },
];

export function RelationshipsPanel(props: {
  store: ReadableStore<RelationshipsPanelSlice>;
  handlers: TableHandlers;
}) {
  // Subscribe for host-notified slice changes (a scope change re-scopes the rows host-side)…
  useReadableStore(props.store);
  // …but render from a fresh getState() read, mirroring the DiagnosticsStripPanel precedent.
  const { rows } = props.store.getState();
  return (
    <div class="koi-relationships-mount">
      <SortableTable
        rows={rows}
        columns={RELATIONSHIP_COLUMNS}
        emptyText="No structural relationships yet — add an aggregate or an entity reference to your model."
        rowLabel={(r) => `${r.source} ${r.relation} ${r.target}`}
        // Key rows on the context-qualified edge, not the unqualified label: under "All contexts" two
        // bounded contexts may each declare the same-named pair (e.g. `Order contains OrderItem` in Sales
        // AND in Billing — type names are only unique per context, R13.2). A non-unique label key would
        // let a sort cross-wire the two same-named rows (#1382 follow-up).
        rowKey={(r) => `${r.contexts.join('>')}:${r.source}:${r.relation}:${r.target}`}
        handlers={props.handlers}
      />
    </div>
  );
}
