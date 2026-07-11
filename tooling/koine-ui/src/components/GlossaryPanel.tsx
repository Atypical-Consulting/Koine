import { useEffect, useRef } from 'preact/hooks';
import { useReadableStore, type ReadableStore } from '../host/store';
import { useCommittableField } from '../useCommittableField';

// The ubiquitous-language glossary editor as a store-coupled koine-ui component (issue #1408,
// fourth-tranche host-adapter migration; originally Koine Studio's src/model/GlossaryPanel.tsx — #67):
// a documentation-coverage gauge plus per-context sections of concept rows, each with an inline
// description editor. Migrated behind a narrow `ReadableStore<GlossaryPanelSlice>` seam — the HOST adapter
// (`createGlossaryPanelStore`) scopes the glossary model to the active bounded context, groups it, and
// computes coverage, so this package never sees `GlossaryModel`, `useAppStore`, or the
// `scopeGlossaryModel`/`groupByContext`/`coverage` classifiers (they stay in their owning Studio modules).
// The description editor uses the same-package `useCommittableField` (open-time capture / cancel-adopts /
// commit-wins — #1385/#1398), so a Cancel/Escape after a Save reverts to the just-saved value, never a
// stale prop.

/** A structural mirror of the LSP `Range` — koine-ui never imports `@/lsp`. */
export interface GlossaryRange {
  start: { line: number; character: number };
  end: { line: number; character: number };
}

/** A plain-primitive mirror of a glossary entry (Koine Studio's `GlossaryEntry`), pre-scoped + grouped by
 *  the host adapter. Structurally identical to the source entry so the host's save handler stays a clean
 *  pass-through (its persist path reads `entry.id`). */
export interface GlossaryEntryView {
  id: string;
  name: string;
  kind: string;
  context: string;
  qualifiedName: string;
  doc: string | null;
  nameRange: GlossaryRange;
}

/** One bounded context's entries, in declaration order (the panel renders the `context`-kind entry first). */
export interface GlossaryGroupView {
  context: string;
  entries: GlossaryEntryView[];
}

/** Documentation coverage over the scoped entries (pre-computed host-side). */
export interface CoverageView {
  documented: number;
  total: number;
  pct: number;
}

/** The narrow slice this panel reads: the pre-scoped + pre-grouped entries and their coverage. */
export interface GlossaryPanelSlice {
  groups: GlossaryGroupView[];
  coverage: CoverageView;
}

export interface GlossaryHandlers {
  /** Jump the editor to a declaration's name range. */
  onGoto(range: GlossaryRange): void;
  /** Persist a description (write the `///` doc comment back to source). */
  onSave(entry: GlossaryEntryView, text: string): void;
}

export function GlossaryPanel(props: {
  store: ReadableStore<GlossaryPanelSlice>;
  handlers: GlossaryHandlers;
  scrollToTerm?: string; // #1165
  scrollNonce?: number; // bumped per new scroll target so it's applied once
}) {
  // Subscribe for host-notified slice changes (a scope change re-groups the entries host-side)…
  useReadableStore(props.store);
  // …but render from a fresh getState() read, mirroring the DiagnosticsStripPanel precedent.
  const { groups, coverage } = props.store.getState();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const appliedNonce = useRef(0);

  useEffect(() => {
    const nonce = props.scrollNonce ?? 0;
    if (!props.scrollToTerm || nonce === 0 || nonce === appliedNonce.current) return;
    const target = hostRef.current?.querySelector<HTMLElement>(`[data-qn="${props.scrollToTerm}"]`);
    if (!target) return;
    appliedNonce.current = nonce;
    target.scrollIntoView({ block: 'center' });
  }, [props.scrollToTerm, props.scrollNonce, groups]);

  return (
    <div class="koi-gloss" ref={hostRef}>
      <div class="koi-gloss-coverage">
        <span>
          <strong>Ubiquitous language</strong>
        </span>
        <span class="koi-gloss-count">
          {coverage.documented} / {coverage.total} documented · {coverage.pct}%
        </span>
      </div>
      <div class="koi-gloss-bar">
        <div class="koi-gloss-bar-fill" style={{ width: `${coverage.pct}%` }} />
      </div>
      {groups.map((g) => (
        <section class="koi-gloss-ctx" key={g.context}>
          <h3>{g.context}</h3>
          {g.entries
            .filter((e) => e.kind === 'context')
            .map((entry) => (
              <GlossaryEntryRow key={entry.qualifiedName} entry={entry} handlers={props.handlers} />
            ))}
          {g.entries
            .filter((e) => e.kind !== 'context')
            .map((entry) => (
              <GlossaryEntryRow key={entry.qualifiedName} entry={entry} handlers={props.handlers} />
            ))}
        </section>
      ))}
    </div>
  );
}

function GlossaryEntryRow(props: { entry: GlossaryEntryView; handlers: GlossaryHandlers }) {
  const { entry, handlers } = props;
  const { editing, draft, setDraft, openEditor, editorOnKeyDown, commit, cancel } = useCommittableField({
    committedValue: entry.doc?.trim() ?? '',
    onCommit: (next) => handlers.onSave(entry, next),
  });
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    if (!editing) return;
    inputRef.current?.focus();
  }, [editing]);
  const hasDoc = draft.trim().length > 0;

  return (
    <div class="koi-gloss-entry" data-qn={entry.qualifiedName}>
      <div class="koi-gloss-entry-head">
        <button
          type="button"
          class="koi-gloss-name"
          title="Go to definition"
          aria-label={`Go to definition: ${entry.name}`}
          onClick={() => handlers.onGoto(entry.nameRange)}
        >
          {entry.name}
        </button>
        <span class="koi-gloss-kind">{entry.kind}</span>
      </div>
      <div class="koi-gloss-body">
        {editing ? (
          <>
            <textarea
              ref={inputRef}
              class="koi-gloss-input"
              rows={2}
              placeholder={`Describe ${entry.name} in plain language…`}
              aria-label={`Description for ${entry.name}`}
              value={draft}
              onInput={(e) => setDraft((e.currentTarget as HTMLTextAreaElement).value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                  e.preventDefault();
                  commit();
                } else {
                  editorOnKeyDown(e); // Escape → hook revert-and-close
                }
              }}
            />
            <div class="koi-gloss-actions">
              <button
                type="button"
                class="koi-gloss-save"
                aria-label={`Save description for ${entry.name}`}
                onClick={commit}
              >
                Save
              </button>
              <button
                type="button"
                class="koi-gloss-cancel"
                aria-label={`Cancel editing description for ${entry.name}`}
                onClick={cancel}
              >
                Cancel
              </button>
            </div>
          </>
        ) : (
          <>
            <p class={hasDoc ? 'koi-gloss-doc' : 'koi-gloss-needsdoc'}>{hasDoc ? draft : 'Needs description'}</p>
            <button
              type="button"
              class="koi-gloss-edit"
              aria-label={`${hasDoc ? 'Edit' : 'Add'} description for ${entry.name}`}
              onClick={openEditor}
            >
              {hasDoc ? 'Edit' : 'Add description'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
