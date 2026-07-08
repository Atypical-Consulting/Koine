import { useEffect, useRef } from 'preact/hooks';
import type { StoreApi } from 'zustand/vanilla';
import type { AppState } from '@/store/index';
import { useAppStore } from '@/store/hooks';
import type { GlossaryModel } from '@/lsp/lsp';
import { renderGlossary, type GlossaryHandlers } from '@/model/glossary';
import { scopeGlossaryModel } from '@/model/activeContext';

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
  /** A qualified-name term to scroll into view (issue #1165) — the launcher's "Open glossary" target. */
  scrollToTerm?: string;
  /** Bumped by the controller each time a NEW scroll target is requested, so it's applied once. */
  scrollNonce?: number;
}) {
  const scope = useAppStore(props.store, (s) => s.activeContext);
  const scoped = scopeGlossaryModel(props.model, scope);
  const hostRef = useRef<HTMLElement | null>(null);
  const appliedNonce = useRef(0);

  // Scroll the requested term into view once per nonce (#1165). The `scoped` dep re-runs this after the
  // callback ref rebuilds the entries (so the anchor exists) and after a scope change; the nonce guard
  // keeps it firing exactly once. A term outside the active scope has no row — no scroll, no error.
  useEffect(() => {
    const nonce = props.scrollNonce ?? 0;
    if (!props.scrollToTerm || nonce === 0 || nonce === appliedNonce.current) return;
    const target = hostRef.current?.querySelector<HTMLElement>(`[data-qn="${props.scrollToTerm}"]`);
    if (!target) return; // term not in the current scope — open, don't scroll (unchanged behavior)
    appliedNonce.current = nonce;
    target.scrollIntoView({ block: 'center' });
  }, [props.scrollToTerm, props.scrollNonce, scoped]);

  return (
    <div
      class="koi-glossary-mount"
      ref={(host: HTMLElement | null) => {
        hostRef.current = host;
        if (!host) return;
        host.replaceChildren(renderGlossary(scoped, props.handlers));
      }}
    />
  );
}
