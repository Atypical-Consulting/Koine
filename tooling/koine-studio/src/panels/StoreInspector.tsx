import type { ComponentChildren } from 'preact';
import type { StoreApi } from 'zustand/vanilla';
import { useStore } from 'zustand';
import type { AppState } from '../store/index';
import { diagnosticsSummary } from '../diagnosticsSummary';

// A read-only live view of the app store — the single source of truth made visible (#193 follow-up).
// It exists to diagnose the cross-panel-sync class of bug the Zustand refactor set out to kill: when a
// panel looks wrong, this overlay shows exactly what the store thinks RIGHT NOW (selection, scope, the
// chrome view fields, the active file, the dirty/diagnostics rollups, and the doc-view staleness
// tokens). Read-only and dev-facing — it owns NO setters, so it can't perturb the state it observes.
//
// Each scalar is its own selector (so a change to one slice repaints only this overlay, never loops);
// the object slices (diagnostics/buffers/docViews) are selected by their immutable reference and
// summarised in render, so no useShallow is needed. Note: docViews' 350ms debounce timer is closure-
// local and never in state, so "a refresh is pending" is deliberately NOT observable here.
export function StoreInspector(props: { store: StoreApi<AppState> }) {
  const s = props.store;
  const selection = useStore(s, (st) => st.selection);
  const activeContext = useStore(s, (st) => st.activeContext);
  const center = useStore(s, (st) => st.center);
  const tech = useStore(s, (st) => st.tech);
  const docs = useStore(s, (st) => st.docs);
  const bottom = useStore(s, (st) => st.bottom);
  const right = useStore(s, (st) => st.right);
  const activeUri = useStore(s, (st) => st.activeUri);
  const buffers = useStore(s, (st) => st.buffers);
  const byUri = useStore(s, (st) => st.diagnosticsByUri);
  const docViews = useStore(s, (st) => st.docViews);

  const dirty = Object.values(buffers).filter((b) => b.dirty).length;
  const { errors, warnings } = diagnosticsSummary(Object.values(byUri).flat());
  const docViewSummary = Object.entries(docViews)
    .map(([k, v]) => `${k}:${v.loaded ? 'ok' : 'stale'}#${v.token}`)
    .join('  ');

  const row = (label: string, fieldName: string, value: ComponentChildren) => (
    <>
      <dt>{label}</dt>
      <dd data-field={fieldName}>{value}</dd>
    </>
  );

  return (
    <div class="koi-store-inspector" role="group" aria-label="Store inspector">
      <header class="koi-store-inspector-title">Store inspector (debug)</header>
      <dl class="koi-store-inspector-grid">
        {row('Selection', 'selection', selection ? selection.qualifiedName : '—')}
        {row('Context', 'activeContext', activeContext)}
        {row('Center', 'center', center)}
        {row('Tech', 'tech', tech)}
        {row('Docs', 'docs', docs)}
        {row('Bottom', 'bottom', bottom)}
        {row('Right', 'right', right)}
        {row('Active file', 'activeUri', activeUri || '—')}
        {row('Dirty files', 'dirty', String(dirty))}
        {row('Problems', 'problems', `${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}`)}
        {row('Doc views', 'docViews', docViewSummary)}
      </dl>
    </div>
  );
}
