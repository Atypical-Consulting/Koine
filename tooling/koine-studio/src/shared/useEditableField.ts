import { useEffect, useRef } from 'preact/hooks';
import type { JSX, RefObject } from 'preact';

// The shared "editable field" primitive for the UNCONTROLLED, implicit blur/Enter-commit family
// (PropertiesPanel's General Name/Description fields and its EditableRow property cells; issue #1385).
// PR #1341 (#992) re-implemented this pattern independently per field, and two of those copies shipped
// the same bug class — a field keyed on its own VALUE instead of the element's stable identity let a
// focus-retaining selection change to a different element skip the remount, so a later blur wrote one
// element's stale, uncommitted text to another. This hook owns the whole contract once:
//
//  - Enter blurs (the commit rides the blur); Escape resets the DOM value to the committed `value`
//    and blurs; blur trims, no-ops on an unchanged (or, unless `commitBlank`, blank) value — resetting
//    the DOM back to `value` — and otherwise calls `onCommit(trimmed)` exactly once.
//  - `key` (=== `identity`) MUST be spread onto the rendered element so a genuine identity change
//    remounts it with the fresh `defaultValue`.
//  - As a second line of defense, an `identity` change also imperatively resets `ref.current.value` —
//    so even a caller that forgets (or mis-derives) the key gets a correct reset instead of a silent
//    wrong-element write. That converts the historical bug class from "possible if a caller mis-keys"
//    to "structurally prevented by the hook".

export interface EditableFieldParams {
  /** The stable identity this field edits (e.g. `qualifiedName` or `qualifiedName:propertyName`) —
   *  NEVER the field's own value: two elements may share a value, but never an identity. */
  identity: string;
  /** The current committed value (normalized — callers pass it trimmed where trimming matters). */
  value: string;
  /** Called with the trimmed new value on a genuine change (see `commitBlank` for the blank case). */
  onCommit: (next: string) => void;
  /** Opt-in: let a cleared (blank) field commit `''` — e.g. deleting a Description is a real commit.
   *  Off by default: for names/types a blank value is invalid and resets instead. */
  commitBlank?: boolean;
}

export interface EditableFieldProps<T extends HTMLInputElement | HTMLTextAreaElement> {
  /** `=== identity`. Spread onto the rendered element so an identity change remounts it. */
  key: string;
  ref: RefObject<T>;
  defaultValue: string;
  /** Enter → blur (commit rides the blur); Escape → reset the DOM value to `value` + blur. */
  onKeyDown: (e: JSX.TargetedKeyboardEvent<T>) => void;
  /** Trim; no-op (reset) on unchanged/blank; otherwise `onCommit(trimmed)`. */
  onBlur: (e: JSX.TargetedFocusEvent<T>) => void;
}

export function useEditableField<T extends HTMLInputElement | HTMLTextAreaElement>(
  params: EditableFieldParams,
): EditableFieldProps<T> {
  const { identity, value, onCommit, commitBlank = false } = params;
  const ref = useRef<T>(null);

  // The identity-change safety net (see the header note). Runs after every render but only ACTS when
  // `identity` changed since the previous render — never on the field's own typing (uncontrolled typing
  // doesn't re-render at all) and never on a mere parent re-render, which must not clobber an
  // in-progress edit. When the caller spreads `key` correctly the element was already remounted with
  // the fresh `defaultValue`, making this write a harmless no-op.
  const prevIdentity = useRef(identity);
  useEffect(() => {
    if (prevIdentity.current === identity) return;
    prevIdentity.current = identity;
    if (ref.current) ref.current.value = value;
  });

  return {
    key: identity,
    ref,
    defaultValue: value,
    onKeyDown: (e) => {
      const el = e.currentTarget;
      if (e.key === 'Enter') {
        e.preventDefault();
        el.blur();
      } else if (e.key === 'Escape') {
        el.value = value;
        el.blur();
      }
    },
    onBlur: (e) => {
      const el = e.currentTarget;
      const next = el.value.trim();
      if (next !== value && (next || commitBlank)) onCommit(next);
      else el.value = value;
    },
  };
}
