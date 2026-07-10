import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import type { StoreApi } from 'zustand/vanilla';
import { useStore } from 'zustand';
import type { AppState } from '@/store/index';
import { diagnosticsSummary } from '@/diagnostics/diagnosticsSummary';

// A read-only live view of the app store — the single source of truth made visible (#193 follow-up).
// It exists to diagnose the cross-panel-sync class of bug the Zustand refactor set out to kill: when a
// panel looks wrong, this overlay shows exactly what the store thinks RIGHT NOW (selection, scope, the
// chrome view fields, the active file, the dirty/diagnostics rollups, the doc-view staleness
// tokens, and the assistant chat rollup). Read-only and dev-facing — it owns NO setters, so it can't
// perturb the state it observes.
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
  // The chat slice is replaced wholesale on every mutation, so its reference is the repaint signal.
  const chat = useStore(s, (st) => st.chat);
  // Serializing the whole store is the EXPENSIVE part of this overlay (every open buffer's text, the
  // whole chat transcript), and the raw-state <details> below is collapsed by default — so the dump
  // lives in a child component mounted only while the details is open (#1134). While collapsed, this
  // overlay costs only the cheap curated selectors above. The details element owns its own open state;
  // its toggle event just mirrors it into rawOpen so the child mounts/unmounts with it.
  const [rawOpen, setRawOpen] = useState(false);

  let dirty = 0;
  for (const b of buffers.values()) if (b.dirty) dirty++;
  const { errors, warnings } = diagnosticsSummary(Object.values(byUri).flat());
  const docViewSummary = Object.entries(docViews)
    .map(([k, v]) => `${k}:${v.loaded ? 'ok' : 'stale'}#${v.token}`)
    .join('  ');
  const msgs = chat.messages.length;
  const chatSummary = `${chat.status}, ${msgs} message${msgs === 1 ? '' : 's'}, ${chat.changeSet ? chat.changeSet.phase.kind : '—'}`;

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
        {row('Assistant', 'chat', chatSummary)}
      </dl>
      <details
        class="koi-store-inspector-raw"
        onToggle={(e) => setRawOpen(e.currentTarget.open)}
      >
        <summary>Raw state</summary>
        {rawOpen && <RawStateDump store={s} />}
      </details>
    </div>
  );
}

// The curated rows are a summary; this dumps the WHOLE store so nothing is hidden. It subscribes to
// the whole state because the curated scalars don't cover every slice (e.g. History's canUndo/canRedo),
// so relying on them alone would leave the snapshot stale on a change to an unsubscribed field. Zustand
// replaces the top-level state object on every set(), so the identity selector repaints on ANY change —
// making the dump track the full store. Mounted only while the raw-state <details> is open (#1134), so
// the collapsed default never pays for the whole-store serialization.
function RawStateDump(props: { store: StoreApi<AppState> }) {
  const fullState = useStore(props.store, (st) => st);
  const rawState = JSON.stringify(
    fullState,
    (_key, value) => {
      if (typeof value === 'function') return undefined; // drop the setters — only data shows
      // The store-owned buffer set is a Map (#982); JSON.stringify renders a Map as `{}`, so expand it to
      // a plain object so the raw dump keeps showing the open buffers keyed by uri.
      if (value instanceof Map) return Object.fromEntries(value);
      return value;
    },
    2,
  );
  return <pre data-field="rawState">{rawState}</pre>;
}
