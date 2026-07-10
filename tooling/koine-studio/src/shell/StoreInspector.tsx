import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
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

// How often the open dump re-serializes at most. During heavy assistant streaming the store is
// replaced once per animation frame (src/ai/textCoalescer.ts floors it at ~60 set()/s), so an
// unthrottled dump would JSON.stringify the whole store per frame; a few repaints a second keeps it
// readable AND cheap. Fresh enough for a debug dump (same ballpark as docViews' 350 ms debounce).
const RAW_DUMP_THROTTLE_MS = 250;

// One serialized dump plus the exact state object it was built from — keeping the source reference
// lets refreshes bail out (returning the previous snapshot, so no repaint) when nothing changed.
interface RawSnapshot {
  state: AppState;
  text: string;
}

function makeRawSnapshot(state: AppState): RawSnapshot {
  return {
    state,
    text: JSON.stringify(
      state,
      (_key, value) => {
        if (typeof value === 'function') return undefined; // drop the setters — only data shows
        // The store-owned buffer set is a Map (#982); JSON.stringify renders a Map as `{}`, so expand it to
        // a plain object so the raw dump keeps showing the open buffers keyed by uri.
        if (value instanceof Map) return Object.fromEntries(value);
        return value;
      },
      2,
    ),
  };
}

// The curated rows are a summary; this dumps the WHOLE store so nothing is hidden. It tracks the whole
// state because the curated scalars don't cover every slice (e.g. History's canUndo/canRedo), so relying
// on them alone would leave the snapshot stale on a change to an unsubscribed field. Mounted only while
// the raw-state <details> is open (#1134), so the collapsed default never pays for the serialization —
// and while open, re-serialization is trailing-edge throttled so the dump repaints a few times a second
// instead of once per store set().
function RawStateDump(props: { store: StoreApi<AppState> }) {
  const s = props.store;
  // Serialize immediately on mount: opening the details always shows a fresh snapshot, never a deferred one.
  const [snapshot, setSnapshot] = useState(() => makeRawSnapshot(s.getState()));

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    // Trailing-edge throttle: the first set() after a quiet period arms ONE timer, further set()s
    // inside the window are absorbed, and the timer re-reads getState() when it fires — so every
    // repaint lands on the LATEST state, at most once per window. Zustand replaces the top-level
    // state object on every set(), so the reference compare in the updater is the "anything changed"
    // check; when nothing did, it returns the previous snapshot and no repaint (or serialization)
    // happens. setTimeout, not rAF, so it also works in non-window contexts (mirroring
    // textCoalescer.ts's fallback rationale).
    const scheduleRefresh = (): void => {
      if (timer !== null) return; // a refresh is already pending — absorb this update into it
      timer = setTimeout(() => {
        timer = null;
        setSnapshot((prev) => {
          const state = s.getState();
          return prev.state === state ? prev : makeRawSnapshot(state);
        });
      }, RAW_DUMP_THROTTLE_MS);
    };
    const unsubscribe = s.subscribe(scheduleRefresh);
    // A set() can land between the mount serialization and this subscription (effects run after the
    // render); arm one reconciling refresh so that window can never leave the dump silently stale.
    // Its updater bails to the previous snapshot when nothing actually changed, so a quiet open costs
    // one no-op timer — never a spurious serialization or repaint.
    scheduleRefresh();
    return () => {
      unsubscribe();
      // Closing the details with a refresh pending must not repaint (or leak the timer) after unmount.
      if (timer !== null) clearTimeout(timer);
    };
  }, [s]);

  return <pre data-field="rawState">{snapshot.text}</pre>;
}
