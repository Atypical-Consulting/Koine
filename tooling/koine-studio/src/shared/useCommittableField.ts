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
//    target — an external refresh can never clobber an in-progress edit.
//
// No `identity`/`key` concept here (unlike `useEditableField`): each row of this family is its own
// component instance, isolated by its parent list's `key`, so cross-element leakage isn't this
// family's failure mode — stale revert targets are.

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

  // Absorb committedValue prop changes. `lastSeen` tracks the prop across renders so the sync fires
  // only on a GENUINE prop change — never on a re-render caused by the hook's own setDraft/commit
  // (where the prop is unchanged but may be stale, the exact case the Glossary fix was about).
  const lastSeen = useRef(committedValue);
  useEffect(() => {
    if (lastSeen.current === committedValue) return;
    lastSeen.current = committedValue;
    if (editing) return; // never clobber an in-progress edit or its open-time revert target
    committedRef.current = committedValue;
    setDraft(committedValue);
  }, [committedValue, editing]);

  return {
    editing,
    draft,
    setDraft,
    openEditor: (): void => {
      // Capture the currently shown value (possibly just-saved, ahead of a stale prop) as the revert
      // target — mirrors GlossaryEntryRow's original `originalRef.current = draft` capture-on-open.
      committedRef.current = draft;
      setEditing(true);
    },
    commit: (): void => {
      onCommit(draft);
      const trimmed = draft.trim();
      committedRef.current = trimmed;
      setDraft(trimmed); // read-view display semantics: show the trimmed committed text
      setEditing(false);
    },
    cancel: (): void => {
      setDraft(committedRef.current); // the internal ref — never a (possibly stale) prop
      setEditing(false);
    },
  };
}
