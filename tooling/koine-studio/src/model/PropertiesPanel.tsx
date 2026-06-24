import type { StoreApi } from 'zustand/vanilla';
import type { AppState } from '@/store/index';
import { useAppStore } from '@/store/hooks';
import {
  renderInspector,
  renderChangeHistory,
  buildInspectorElement,
  KOINE_BUILTIN_TYPES,
  type InspectorElement,
  type InspectorHandlers,
} from '@/model/inspector';
import { lookupElement, type ModelIndex } from '@/model/modelIndex';

/**
 * The type names the Properties panel offers as autocomplete for a property's type: the model's own
 * declared types (every glossary entry except bounded contexts) followed by the language built-ins,
 * deduped with declaration order preserved. Empty until the model index has resolved.
 */
function knownTypesFrom(index: ModelIndex | null): string[] {
  const declared = (index?.glossary.entries ?? [])
    .filter((e) => e.kind !== 'context')
    .map((e) => e.name);
  return Array.from(new Set([...declared, ...KOINE_BUILTIN_TYPES]));
}

// The right-rail Properties inspector as a Preact panel (issue #142, the first migrated panel of #193).
// It subscribes to the `selection` slice ONLY, so an unrelated slice change (e.g. a bottom-tab switch)
// never re-renders it — the strangler step that kills the cross-panel sync bugs. The inspector view
// itself stays the existing pure DOM builder (`renderInspector`), mounted via a callback ref so the
// imperative renderer is reused untouched. The joined model index is passed in (the controller owns the
// fetch); when nothing is selected or the index is absent, the inspector renders its own empty state.
export function PropertiesPanel(props: {
  store: StoreApi<AppState>;
  index: ModelIndex | null;
  handlers: InspectorHandlers;
}) {
  // Subscribe to exactly the selection slice. `useAppStore` with this selector re-renders the component
  // only when `selection` changes reference — a setBottom/setActiveContext call leaves it alone.
  const selection = useAppStore(props.store, (s) => s.selection);
  const hit = selection && props.index ? lookupElement(props.index, selection.qualifiedName) : null;
  const element: InspectorElement | null = hit
    ? buildInspectorElement(hit.element.entry, hit.element.node, hit.element.modelMembers)
    : null;
  const knownTypes = knownTypesFrom(props.index);
  // Reuse the imperative renderInspector by mounting its output through a callback ref. The ref runs on
  // every render with the freshly-projected element, so the inspector tracks the selection.
  return (
    <div
      class="koi-inspector-mount"
      ref={(host: HTMLElement | null) => {
        if (!host) return;
        const root = renderInspector(element, props.handlers, knownTypes);
        host.replaceChildren(root);
        // Per-element git change history (#150): fetched asynchronously (the desktop host shells out to
        // git) and appended once it resolves, so the synchronous inspector paint isn't blocked. A null /
        // empty result appends nothing — the section stays hidden on the browser host or outside a git
        // repo. Guard against a stale resolve: if the selection moved on, `root` is no longer mounted (the
        // next render replaced it) or carries a different qname, so we drop the late result.
        if (element && props.handlers.loadHistory) {
          const loadHistory = props.handlers.loadHistory;
          // Wrap in Promise.resolve().then so even a synchronous throw inside loadHistory becomes a
          // rejection the .catch swallows, never escaping the ref callback into Preact's commit.
          void Promise.resolve()
            .then(() => loadHistory(element))
            .then((entries) => {
              if (!root.isConnected || root.dataset.qname !== element.qualifiedName) return;
              const section = renderChangeHistory(entries);
              if (section) root.appendChild(section);
            })
            .catch(() => {
              /* history is best-effort — a failure just leaves the section hidden */
            });
        }
      }}
    />
  );
}
