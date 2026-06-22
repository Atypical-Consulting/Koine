import type { StoreApi } from 'zustand/vanilla';
import { useStore } from 'zustand';
import type { AppState } from '../store/index';
import { isAllContexts } from '../activeContext';

// A read-only "where am I" breadcrumb (#193 follow-up): the active bounded-context scope and, when one
// is selected, the inspected element — e.g. "Ordering › Order". It subscribes to the activeContext and
// selection slices as TWO separate selectors (the ModelOutlinePanel pattern), so it tracks all three
// scope-change paths (the switcher, the selection-follow, and the active-file follow) and the selection
// with no controller wiring. The scope label reuses the app's "All contexts" vocabulary (isAllContexts).
//
// Deliberately read-only: clicking a crumb to re-scope would have to route through the controller's
// choke point (so the imperative <select> and the scoped bottom tables stay consistent), which is a
// separate, larger change — this panel only REFLECTS state.
export function ContextBreadcrumb(props: { store: StoreApi<AppState> }) {
  const scope = useStore(props.store, (s) => s.activeContext);
  const selection = useStore(props.store, (s) => s.selection);
  const scopeLabel = isAllContexts(scope) ? 'All contexts' : scope;
  // The element's simple name is the last dotted segment (Ordering.Order → Order); fall back to the
  // whole qualified name if it somehow carries no dot.
  const elementName = selection ? (selection.qualifiedName.split('.').pop() ?? selection.qualifiedName) : null;
  return (
    <nav class="koi-breadcrumb" aria-label="Current scope">
      <span class="koi-crumb" data-role="crumb-scope">
        {scopeLabel}
      </span>
      {elementName != null && (
        <>
          <span class="koi-crumb-sep" aria-hidden="true">
            ›
          </span>
          <span class="koi-crumb koi-crumb-leaf" data-role="crumb-element">
            {elementName}
          </span>
        </>
      )}
    </nav>
  );
}
