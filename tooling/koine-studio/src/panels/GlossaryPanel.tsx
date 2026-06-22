import type { StoreApi } from 'zustand/vanilla';
import type { AppState } from '@/store/index';
import { useAppStore } from '@/store/hooks';
import type { GlossaryModel } from '@/lsp';
import { renderGlossary, type GlossaryHandlers } from '@/glossary';
import { scopeGlossaryModel } from '@/activeContext';

// The ubiquitous-language glossary editor as a Preact panel (#193, #67, #146). It subscribes to the
// `activeContext` slice and narrows the glossary model to that bounded context, so switching scope
// re-renders the glossary for the active context ("All contexts" is the identity). The model is passed in
// — the controller owns the LSP fetch (glossaryModel) under the docViews stale-token discipline; this
// panel only re-frames it. The editor stays the existing pure DOM builder (`renderGlossary`, with its
// coverage gauge + inline description editors), mounted through a callback ref so the imperative renderer
// is reused untouched; it re-runs on every render with the freshly-scoped model, so it tracks the scope.
export function GlossaryPanel(props: {
  store: StoreApi<AppState>;
  model: GlossaryModel;
  handlers: GlossaryHandlers;
}) {
  const scope = useAppStore(props.store, (s) => s.activeContext);
  const scoped = scopeGlossaryModel(props.model, scope);
  return (
    <div
      class="koi-glossary-mount"
      ref={(host: HTMLElement | null) => {
        if (!host) return;
        host.replaceChildren(renderGlossary(scoped, props.handlers));
      }}
    />
  );
}
