import type { StoreApi } from 'zustand/vanilla';
import { useStore } from 'zustand';
import type { AppState } from '@/store/index';
import { isAllContexts } from '@/model/activeContext';
import type { AddNodeKind } from '@/diagrams/diagramContract';

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

// Not yet wired to a model edit — shown disabled so the toolbar matches the agreed mockup and each can be
// enabled later without moving the others. Relation points the modeller at the existing connect gesture;
// Rule/Repository live inside an aggregate and Note/Group are canvas-only annotations (deferred by design).
const COMING_SOON: { label: string; tooltip: string }[] = [
  { label: 'Rule', tooltip: 'Coming soon' },
  { label: 'Repository', tooltip: 'Coming soon' },
  { label: 'Relation', tooltip: 'Drag from one node to another to connect' },
  { label: 'Note', tooltip: 'Coming soon' },
  { label: 'Group', tooltip: 'Coming soon' },
];

// The construct palette above the domain canvas. Subscribes to the active-context slice so the
// round-trip buttons enable only when there's an unambiguous home context: a single bounded context is
// active, OR "All contexts" is selected but the model has exactly one context (then it's the only target,
// and the add path resolves to it). Controller-free: clicks call the injected onAdd callback.
export function CanvasPalette(props: { store: StoreApi<AppState>; onAdd: (kind: AddNodeKind) => void }) {
  const scope = useStore(props.store, (s) => s.activeContext);
  const contexts = useStore(props.store, (s) => s.contexts);
  const enabled = !isAllContexts(scope) || contexts.length === 1;
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
