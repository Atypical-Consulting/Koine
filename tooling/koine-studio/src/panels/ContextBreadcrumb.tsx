import type { StoreApi } from 'zustand/vanilla';
import { useStore } from 'zustand';
import type { AppState } from '../store/index';
import { ALL_CONTEXTS, isAllContexts, type ContextScope } from '../activeContext';
import { lookupElement, type ModelIndex } from '../modelIndex';
import { constructForKind } from '../modelOutline';

export interface ContextBreadcrumbProps {
  store: StoreApi<AppState>;
  /** The model's bounded contexts in display order — the scope selector's options after "All contexts". */
  contexts: string[];
  /** The joined model index, used to resolve the selected element's DDD construct (for its type icon). */
  index: ModelIndex | null;
  /** Re-scope the whole workspace. Routes through the controller's choke point (persist + repaint), so
   *  the bottom tables / diagram stay consistent — never the store slice directly. */
  onScopeChange: (scope: ContextScope) => void;
}

// The top-bar "scope path" (#193 / #146 follow-up): one breadcrumb that doubles as the scope control.
// The FIRST segment is a real <select> dressed as a crumb — picking re-scopes the whole workspace; the
// SECOND, when an element is selected, is its simple name prefixed with the SAME construct icon the
// Explorer leaves use (constructForKind → .koi-model-icon), so the top bar and the left rail share one
// colour language. It subscribes to the activeContext + selection slices for the reactive bits and takes
// the contexts list + model index as props (re-passed by the controller when either changes), mirroring
// the PropertiesPanel pattern. Replaces the old label + <select> + "Current context" readout trio; the
// persistent "Context: X" readout now lives only in the status bar.
export function ContextBreadcrumb({ store, contexts, index, onScopeChange }: ContextBreadcrumbProps) {
  const scope = useStore(store, (s) => s.activeContext);
  const selection = useStore(store, (s) => s.selection);
  const scoped = !isAllContexts(scope);

  // The element's simple name is the last dotted segment (Ordering.Order → Order); fall back to the
  // whole qualified name if it somehow carries no dot. Its construct (for the type icon + tooltip) is
  // resolved through the model index — absent while the index is still warming up, so the crumb degrades
  // to just the name until it lands.
  const elementName = selection
    ? (selection.qualifiedName.split('.').pop() ?? selection.qualifiedName)
    : null;
  const hit = selection && index ? lookupElement(index, selection.qualifiedName) : null;
  const construct = hit ? constructForKind(hit.element.entry.kind) : null;

  return (
    <nav class="koi-breadcrumb" aria-label="Active scope">
      <span class="koi-crumb-scope-wrap" data-scoped={scoped ? 'true' : 'false'}>
        <select
          class="koi-crumb-scope"
          data-role="crumb-scope"
          aria-label="Active bounded context"
          value={scope}
          onChange={(e) => onScopeChange((e.currentTarget as HTMLSelectElement).value)}
        >
          <option value={ALL_CONTEXTS}>All contexts</option>
          {contexts.map((c) => (
            <option value={c} key={c}>
              {c}
            </option>
          ))}
        </select>
        <svg class="koi-crumb-chevron" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M4.5 6.5 8 10l3.5-3.5" />
        </svg>
      </span>
      {elementName != null && (
        <>
          <span class="koi-crumb-sep" aria-hidden="true">
            ›
          </span>
          <span
            class="koi-crumb koi-crumb-leaf"
            data-role="crumb-element"
            title={construct ? construct.label : undefined}
          >
            {construct != null && (
              <span class="koi-model-icon" data-construct={construct.slug} aria-hidden="true" />
            )}
            {elementName}
          </span>
        </>
      )}
    </nav>
  );
}
