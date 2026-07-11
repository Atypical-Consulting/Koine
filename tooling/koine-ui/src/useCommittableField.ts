import { useEffect, useRef, useState } from 'preact/hooks';

// The shared "committable field" primitive for the CONTROLLED, explicit edit-mode family
// (GlossaryPanel's GlossaryEntryRow, DocsPanels' AdrRow/NoteRow; issue #1385): a read view with an
// Edit affordance that opens a controlled editor with Save/Cancel. PR #1341 (#992) implemented this
// three times, and one copy shipped the stale-prop-revert bug (`fix(studio): revert glossary
// edit-cancel to the last committed value`): Cancel/Escape reverted to the committedValue PROP — which
// only refreshes on a debounced reload — instead of the row's own last-committed value, silently
// undoing a just-completed Save. This hook closes that class by construction:
//
//  - `commit()` and `cancel()` work exclusively against an INTERNAL last-committed ref — never a
//    re-read of the prop — so a revert can never resurrect a value older than this hook's own commit.
//  - While NOT editing, a genuine `committedValue` prop change (a lazy async load resolving, a
//    canonical re-render of just-saved content) refreshes both the idle draft and the revert target —
//    so `openEditor()` always works from the value current at CALL time, never one frozen at mount.
//  - While EDITING, a prop change is absorbed without touching the draft or the open-time revert
//    target — an external refresh can never clobber an in-progress edit — but it IS remembered as a
//    `pendingExternal` value: `cancel()` (and Escape) adopts it, showing the latest committed truth
//    instead of the open-time snapshot; `commit()` discards it, since the user's explicit save is the
//    newer truth and must not be silently overridden by a background refresh (cancel-adopts /
//    commit-wins — issue #1398). `openEditor()` clears any stale pending value so a previous edit
//    session can't leak into a new one.
//
// No `identity`/`key` concept here (unlike `useEditableField`): each row of this family is its own
// component instance, isolated by its parent list's `key`, so cross-element leakage isn't this
// family's failure mode — stale revert targets are.
//
// Moved verbatim from koine-studio's src/shared/useCommittableField.ts into @atypical/koine-ui
// (issue #1408, fourth-tranche host-adapter migration) so the migrated GlossaryPanel can consume it
// from the same package; the hook has no store/Tauri coupling (only preact/hooks), so it moves as-is.

export interface CommittableField {
  /** Whether the editor is open (the caller renders the editor vs. the read view on this). */
  editing: boolean;
  /** The editor's controlled value while editing; the last committed (trimmed) text while idle. */
  draft: string;
  setDraft: (next: string) => void;
  /** Captures the current value as the revert target and enters edit mode. */
  openEditor: () => void;
  /** Calls `onCommit(draft)` (untrimmed — the caller decides how to persist), keeps the trimmed text
   *  as the new committed value/read-view text, and exits edit mode. */
  commit: () => void;
  /** Reverts the draft to the internal last-committed value (never a prop) and exits edit mode. */
  cancel: () => void;
  /** The editor's keydown handler: Escape → `preventDefault()` + {@link cancel} (the same
   *  revert-and-close path as the Cancel button); every other key falls through untouched. Callers
   *  with extra editor shortcuts (e.g. Glossary's Ctrl/Cmd+Enter → commit) handle theirs first and
   *  delegate the rest here. Typed on the two members it reads so a test can drive it with a plain
   *  object; any real (Preact-targeted) KeyboardEvent satisfies it. */
  editorOnKeyDown: (e: Pick<KeyboardEvent, 'key' | 'preventDefault'>) => void;
}

export function useCommittableField(params: {
  /** The committed value as the CALLER currently knows it. May lag the hook's own commits (e.g. a
   *  debounced reload) — the hook never lets that staleness reach a revert. */
  committedValue: string;
  onCommit: (next: string) => void;
}): CommittableField {
  const { committedValue, onCommit } = params;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(committedValue);
  // The revert target: what this hook last saw committed — seeded from the prop, then owned by
  // commit() (and refreshed from a genuine idle-time prop change below). cancel() reads ONLY this.
  const committedRef = useRef(committedValue);
  // A mid-edit external change, remembered but not yet acted on — cancel() adopts it, commit() and
  // openEditor() discard it. `string | null` (not falsiness) so an empty-string external value is a
  // valid pending value, distinct from "none pending".
  const pendingExternal = useRef<string | null>(null);

  // Absorb committedValue prop changes. `lastSeen` tracks the prop across renders so the sync fires
  // only on a GENUINE prop change — never on a re-render caused by the hook's own setDraft/commit
  // (where the prop is unchanged but may be stale, the exact case the Glossary fix was about).
  const lastSeen = useRef(committedValue);
  useEffect(() => {
    if (lastSeen.current === committedValue) return;
    lastSeen.current = committedValue;
    if (editing) {
      pendingExternal.current = committedValue; // remembered for cancel() to adopt; draft/revert untouched
      return;
    }
    committedRef.current = committedValue;
    setDraft(committedValue);
  }, [committedValue, editing]);

  const cancel = (): void => {
    if (pendingExternal.current !== null) {
      committedRef.current = pendingExternal.current;
      setDraft(pendingExternal.current); // cancel-adopts: show the latest external truth
      pendingExternal.current = null;
    } else {
      setDraft(committedRef.current); // the internal ref — never a (possibly stale) prop
    }
    setEditing(false);
  };

  return {
    editing,
    draft,
    setDraft,
    openEditor: (): void => {
      // Capture the currently shown value (possibly just-saved, ahead of a stale prop) as the revert
      // target — mirrors GlossaryEntryRow's original `originalRef.current = draft` capture-on-open.
      committedRef.current = draft;
      pendingExternal.current = null; // a previous session's pending value must not leak into this one
      setEditing(true);
    },
    commit: (): void => {
      pendingExternal.current = null; // commit-wins: the user's explicit save overrides any pending refresh
      onCommit(draft);
      const trimmed = draft.trim();
      committedRef.current = trimmed;
      setDraft(trimmed); // read-view display semantics: show the trimmed committed text
      setEditing(false);
    },
    cancel,
    editorOnKeyDown: (e): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        cancel();
      }
    },
  };
}
