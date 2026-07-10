import { useEffect, useRef } from 'preact/hooks';
import type { StoreApi } from 'zustand/vanilla';
import type { AppState } from '@/store/index';
import { useAppStore } from '@/store/hooks';
import type { GlossaryEntry, GlossaryModel } from '@/lsp/lsp';
import { coverage, groupByContext, type GlossaryHandlers } from '@/model/glossary';
import { scopeGlossaryModel } from '@/model/activeContext';
import { useCommittableField } from '@/shared/useCommittableField';

// The ubiquitous-language glossary editor as a Preact panel (#193, #67, #146, #992). It subscribes to
// the `activeContext` slice and narrows the glossary model to that bounded context, so switching scope
// re-renders the glossary for the active context ("All contexts" is the identity). The model is passed
// in — the controller owns the LSP fetch (glossaryModel) under the docViews stale-token discipline;
// this panel only re-frames it. The coverage gauge, bar, and per-context sections render as real JSX;
// each entry is a `GlossaryEntryRow` owning its own inline description editor (#992 retired the pure-DOM
// `renderGlossary` builder and the callback-ref bridge that mounted it).
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
  const hostRef = useRef<HTMLDivElement | null>(null);
  const appliedNonce = useRef(0);

  // Scroll the requested term into view once per nonce (#1165). The `scoped` dep re-runs this after a
  // scope change (so the anchor for the newly-scoped entries exists); the nonce guard keeps it firing
  // exactly once. A term outside the active scope has no row — no scroll, no error.
  useEffect(() => {
    const nonce = props.scrollNonce ?? 0;
    if (!props.scrollToTerm || nonce === 0 || nonce === appliedNonce.current) return;
    const target = hostRef.current?.querySelector<HTMLElement>(`[data-qn="${props.scrollToTerm}"]`);
    if (!target) return; // term not in the current scope — open, don't scroll (unchanged behavior)
    appliedNonce.current = nonce;
    target.scrollIntoView({ block: 'center' });
  }, [props.scrollToTerm, props.scrollNonce, scoped]);

  const { documented, total, pct } = coverage(scoped.entries);

  return (
    <div class="koi-gloss" ref={hostRef}>
      <div class="koi-gloss-coverage">
        <span>
          <strong>Ubiquitous language</strong>
        </span>
        <span class="muted">
          {documented} / {total} documented · {pct}%
        </span>
      </div>
      <div class="koi-gloss-bar">
        <div class="koi-gloss-bar-fill" style={{ width: `${pct}%` }} />
      </div>

      {groupByContext(scoped.entries).map((g) => (
        <section class="koi-gloss-ctx" key={g.context}>
          <h3>{g.context}</h3>
          {/* The context's own entry first (so its description can be authored), then its types. */}
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

/**
 * One glossary row: name (jumps to source) + kind badge + description with an inline editor. The
 * edit-mode/draft/revert state is a `useCommittableField` (see `@/shared/useCommittableField` for the
 * contract): `draft` holds both the read view's current text AND the textarea's live value while
 * editing, and Cancel/Escape revert to the hook's own last-committed value — never the `entry.doc`
 * prop, which only refreshes on a debounced (350ms) reload and so can still hold the pre-save text
 * right after a Save (the #992-review bug class the hook exists to close).
 */
function GlossaryEntryRow(props: { entry: GlossaryEntry; handlers: GlossaryHandlers }) {
  const { entry, handlers } = props;
  const { editing, draft, setDraft, openEditor, commit, cancel } = useCommittableField({
    committedValue: entry.doc?.trim() ?? '',
    onCommit: (next) => handlers.onSave(entry, next),
  });
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  // Focus the textarea once, right when editing STARTS — not on every keystroke (mirrors ExplorerItem's
  // rename-input focus effect).
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
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  cancel();
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
