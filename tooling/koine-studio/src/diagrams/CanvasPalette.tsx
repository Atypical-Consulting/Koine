import type { StoreApi } from 'zustand/vanilla';
import { useStore } from 'zustand';
import type { AppState } from '@/store/index';
import { isAllContexts } from '@/model/activeContext';
import { lookupElement, type ModelIndex } from '@/model/modelIndex';
import type { AddNodeKind, CanvasAnnotationKind, AggregateMemberKind } from '@/diagrams/diagramContract';

// The DDD constructs that round-trip to `.koi` via the addType seam (server Task 1). Each `kind` doubles
// as the `koi-model-icon` `data-construct` slug, so a button wears the SAME shape-coded glyph the diagram
// nodes and Explorer use (blue diamond = value, amber circle = enum, …) and reads as the node it creates.
const CONSTRUCTS: { kind: AddNodeKind; label: string }[] = [
  { kind: 'entity', label: 'Entity' },
  { kind: 'value', label: 'Value Object' },
  { kind: 'aggregate', label: 'Aggregate' },
  { kind: 'service', label: 'Service' },
  { kind: 'event', label: 'Event' },
  { kind: 'enum', label: 'Enum' },
];

// Canvas-only annotations (#255): NOT model constructs — they persist in koine.layout.json, never `.koi`,
// so they're context-free and stay enabled regardless of the active-context scope. A swatch (note amber /
// group violet) marks them apart from the round-trip constructs above and the muted coming-soon buttons.
const ANNOTATIONS: { kind: CanvasAnnotationKind; label: string; tooltip: string }[] = [
  { kind: 'note', label: 'Note', tooltip: 'Add a free-text note (canvas-only annotation)' },
  { kind: 'group', label: 'Group', tooltip: 'Group the selected nodes (canvas-only annotation)' },
];

// Constructs that live INSIDE an aggregate (#254): inserted into the SELECTED aggregate via the
// addAggregateMember seam, not the context-scoped addType. `rule` adds an aggregate-scoped `spec` (a
// reusable boolean rule over the root); `repository` adds the root's repository block. They gate on a
// selected aggregate rather than the active context.
const AGGREGATE_CONSTRUCTS: { kind: AggregateMemberKind; label: string }[] = [
  { kind: 'rule', label: 'Rule' },
  { kind: 'repository', label: 'Repository' },
];

// Not yet wired to a model edit — shown disabled so the toolbar matches the agreed mockup and each can be
// enabled later without moving the others. Relation points the modeller at the existing connect gesture;
// Rule/Repository (#254) and Note/Group (#255) now ship as their own enabled buttons above.
const COMING_SOON: { label: string; tooltip: string }[] = [
  { label: 'Relation', tooltip: 'Drag from one node to another to connect' },
];

// The construct palette above the domain canvas. Context-scoped constructs (addType) enable when there's
// an unambiguous home context: a single bounded context is active, OR "All contexts" is selected but the
// model has exactly one context. Aggregate-scoped constructs (rule/repository, #254) enable when the
// selection resolves to an aggregate, and target that aggregate (the model `index` resolves the
// selection's kind, re-passed by the controller when the index rebuilds, like the Properties panel).
// Annotations (note/group, #255) are context-free — always enabled. Controller-free: clicks call the
// injected callbacks.
export function CanvasPalette(props: {
  store: StoreApi<AppState>;
  index: ModelIndex | null;
  onAdd: (kind: AddNodeKind) => void;
  onAddAggregateMember: (kind: AggregateMemberKind, aggregateQualifiedName: string) => void;
  onAddAnnotation: (kind: CanvasAnnotationKind) => void;
}) {
  const scope = useStore(props.store, (s) => s.activeContext);
  const contexts = useStore(props.store, (s) => s.contexts);
  const selection = useStore(props.store, (s) => s.selection);
  const enabled = !isAllContexts(scope) || contexts.length === 1;

  // The selected aggregate's canonical qualified name (the addAggregateMember target), or null when the
  // selection isn't an aggregate — which gates the rule/repository buttons.
  const hit = selection && props.index ? lookupElement(props.index, selection.qualifiedName) : null;
  const aggregateQn = hit && hit.element.entry.kind === 'aggregate' ? hit.canonicalQn : null;

  return (
    <div class="koi-canvas-palette" role="toolbar" aria-label="Add domain construct">
      {CONSTRUCTS.map((c) => (
        <button
          type="button"
          class="koi-palette-btn"
          data-kind={c.kind}
          key={c.kind}
          title={enabled ? `Add ${c.label}` : 'Select a bounded context first'}
          aria-label={`Add ${c.label}`}
          disabled={!enabled}
          onClick={() => props.onAdd(c.kind)}
        >
          <span class="koi-model-icon" data-construct={c.kind} aria-hidden="true" />
          <span class="koi-palette-label">{c.label}</span>
        </button>
      ))}
      {AGGREGATE_CONSTRUCTS.map((c) => (
        <button
          type="button"
          class="koi-palette-btn"
          data-kind={c.kind}
          key={c.kind}
          title={aggregateQn ? `Add ${c.label} to the selected aggregate` : 'Select an aggregate first'}
          aria-label={`Add ${c.label}`}
          disabled={aggregateQn == null}
          onClick={() => aggregateQn && props.onAddAggregateMember(c.kind, aggregateQn)}
        >
          <span class="koi-model-icon" data-construct={c.kind} aria-hidden="true" />
          <span class="koi-palette-label">{c.label}</span>
        </button>
      ))}
      <span class="koi-palette-sep" aria-hidden="true" />
      {ANNOTATIONS.map((a) => (
        <button
          type="button"
          class="koi-palette-btn"
          data-annotation={a.kind}
          key={a.kind}
          title={a.tooltip}
          aria-label={`Add ${a.label}`}
          onClick={() => props.onAddAnnotation(a.kind)}
        >
          <span class={`koi-palette-swatch koi-palette-swatch--${a.kind}`} aria-hidden="true" />
          <span class="koi-palette-label">{a.label}</span>
        </button>
      ))}
      <span class="koi-palette-sep" aria-hidden="true" />
      {COMING_SOON.map((c) => (
        <button
          type="button"
          class="koi-palette-btn koi-palette-btn--soon"
          key={c.label}
          title={c.tooltip}
          aria-label={`${c.label} (coming soon)`}
          disabled
        >
          <span class="koi-palette-swatch" aria-hidden="true" />
          <span class="koi-palette-label">{c.label}</span>
        </button>
      ))}
    </div>
  );
}
