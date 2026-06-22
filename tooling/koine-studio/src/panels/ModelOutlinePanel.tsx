import type { StoreApi } from 'zustand/vanilla';
import type { AppState } from '../store/index';
import { useAppStore } from '../store/hooks';
import type { GlossaryModel } from '../lsp';
import { renderModelOutline, type ModelOutlineHandlers } from '../modelOutline';
import { filterGlossaryModel, scopeGlossaryModel } from '../activeContext';
import { lookupElement, type ModelIndex } from '../modelIndex';

// The left-rail Explorer construct tree as a Preact panel (#193, #146). It subscribes to TWO slices of
// the app store: `activeContext` (the bounded-context scope that narrows the tree) and `selection` (the
// cross-highlight that lights up the selected leaf). The model itself is passed in — the controller owns
// the LSP fetch and the joined index; this panel only re-frames it. The tree itself stays the existing
// pure DOM builder (`renderModelOutline`), mounted through a callback ref so the imperative renderer is
// reused untouched; the ref runs on every render with the freshly-scoped model, so the tree tracks the
// scope, and the `is-selected` toggle tracks the selection — the same highlight the controller used to
// own imperatively. Counts are suppressed here (the dedicated Overview section owns the tallies), exactly
// as the controller's old `renderModelOutline(..., { counts: false })` call did.
export function ModelOutlinePanel(props: {
  store: StoreApi<AppState>;
  model: GlossaryModel;
  handlers: ModelOutlineHandlers;
  /** The joined model index, used to canonicalize the selection's qn before matching a leaf. */
  index?: ModelIndex | null;
}) {
  // Subscribe to exactly the two slices that drive this panel; an unrelated slice change leaves it alone.
  const scope = useAppStore(props.store, (s) => s.activeContext);
  const selection = useAppStore(props.store, (s) => s.selection);
  // The type-to-filter query lives in the store (uiChrome.outlineFilter), NOT component-local state: the
  // controller unmounts + remounts this panel on every model reload, so a local query would be wiped
  // mid-task on each edit — the store-backed value survives the remount. It composes AFTER the context
  // scope, so the box filters within the active bounded context.
  const query = useAppStore(props.store, (s) => s.outlineFilter);
  const scoped = filterGlossaryModel(scopeGlossaryModel(props.model, scope), query);
  // Match the deleted applySelectionHighlight exactly: resolve the selection to its canonical qn (a
  // diagram-node selection can carry a non-canonical key form) before comparing against leaf.dataset.qname
  // (which renderModelOutline sets to the canonical entry.qualifiedName). Without the index, fall back to
  // the raw qn — the same `?? sel.qualifiedName` the controller used.
  const hit = selection && props.index ? lookupElement(props.index, selection.qualifiedName) : null;
  const qn = hit?.canonicalQn ?? selection?.qualifiedName ?? null;
  return (
    <div class="koi-outline">
      <input
        type="search"
        class="koi-outline-filter"
        placeholder="Filter constructs…"
        aria-label="Filter model constructs by name"
        value={query}
        onInput={(e) => props.store.getState().setOutlineFilter((e.currentTarget as HTMLInputElement).value)}
      />
      <div
        class="koi-outline-mount"
        ref={(host: HTMLElement | null) => {
          if (!host) return;
          // nav:false — the Context Map / Ubiquitous Language shortcuts now live in the rail's own
          // "Documentation" section, so the outline no longer tacks orphaned buttons onto its tail.
          host.replaceChildren(renderModelOutline(scoped, props.handlers, { counts: false, nav: false }));
          // Cross-highlight the selected leaf — the same is-selected toggle the controller applied.
          for (const leaf of Array.from(host.querySelectorAll<HTMLElement>('.koi-model-leaf'))) {
            leaf.classList.toggle('is-selected', qn != null && leaf.dataset.qname === qn);
          }
        }}
      />
    </div>
  );
}
