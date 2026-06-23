import type { StoreApi } from 'zustand/vanilla';
import { useStore } from 'zustand';
import type { AppState } from '@/store/index';
import { isAllContexts } from '@/model/activeContext';
import type { AddNodeKind } from '@/diagrams/diagramContract';

// The DDD constructs that round-trip to `.koi` via the addType seam (server Task 1). `data-kind` drives
// the swatch colour (the matching --koi-ddd-* token) in SCSS, so a button reads as the node it creates.
const CONSTRUCTS: { kind: AddNodeKind; label: string }[] = [
  { kind: 'entity', label: 'Entity' },
  { kind: 'value', label: 'Value Object' },
  { kind: 'aggregate', label: 'Aggregate' },
  { kind: 'event', label: 'Event' },
  { kind: 'enum', label: 'Enum' },
];

// Not yet wired to a model edit — shown disabled so the toolbar matches the agreed mockup and each can be
// enabled later without moving the others. Relation points the modeller at the existing connect gesture.
const COMING_SOON: { label: string; tooltip: string }[] = [
  { label: 'Service', tooltip: 'Coming soon' },
  { label: 'Rule', tooltip: 'Coming soon' },
  { label: 'Repository', tooltip: 'Coming soon' },
  { label: 'Relation', tooltip: 'Drag from one node to another to connect' },
  { label: 'Note', tooltip: 'Coming soon' },
  { label: 'Group', tooltip: 'Coming soon' },
];

// The construct palette above the domain canvas. Subscribes to the active-context slice so the
// round-trip buttons enable only when a single bounded context is the target (adding into "All
// contexts" has no unambiguous home). Controller-free: clicks call the injected onAdd callback.
export function CanvasPalette(props: { store: StoreApi<AppState>; onAdd: (kind: AddNodeKind) => void }) {
  const scope = useStore(props.store, (s) => s.activeContext);
  const enabled = !isAllContexts(scope);
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
          <span class="koi-palette-swatch" aria-hidden="true" />
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
