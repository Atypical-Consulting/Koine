import { describe, expect, test, vi } from 'vitest';
import { act, fireEvent, render } from '@testing-library/preact';
import { h } from 'preact';
import { useEditableField } from '@/shared/useEditableField';

// Harness: an uncontrolled <input> wired exactly the way a real caller spreads the hook's props
// (GeneralSection's Name field, EditableRow's name/type cells). `withKey: false` deliberately DROPS the
// returned `key` — simulating a caller that forgets to key the element on identity — so the hook's own
// identity-change reset (the safety net that structurally closes the #992 colliding-key bug class) is
// exercised without Preact remounting the element for us.
function Field(props: {
  identity: string;
  value: string;
  onCommit: (next: string) => void;
  commitBlank?: boolean;
  withKey?: boolean;
}) {
  const field = useEditableField<HTMLInputElement>({
    identity: props.identity,
    value: props.value,
    onCommit: props.onCommit,
    commitBlank: props.commitBlank,
  });
  if (props.withKey === false) {
    const { key, ...rest } = field;
    void key; // dropped on purpose — see the harness comment
    return h('input', { 'aria-label': 'field', ...rest });
  }
  return h('input', { 'aria-label': 'field', ...field });
}

const getInput = (container: Element) => container.querySelector<HTMLInputElement>('input')!;

/** Focus the field, set its DOM value (as uncontrolled typing does), and flush the input event. */
function type(input: HTMLInputElement, text: string): void {
  act(() => input.focus());
  input.value = text;
  act(() => {
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('useEditableField', () => {
  test('returns key === identity and seeds defaultValue with the committed value', () => {
    const { container } = render(h(Field, { identity: 'Sales.Order', value: 'Order', onCommit: () => {} }));
    const input = getInput(container);
    expect(input.value).toBe('Order');
  });

  test('Enter blurs the element; the commit happens exactly once, via the blur handler', () => {
    const onCommit = vi.fn();
    const { container } = render(h(Field, { identity: 'id', value: 'Order', onCommit }));
    const input = getInput(container);

    type(input, 'PurchaseOrder');
    act(() => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });

    expect(document.activeElement).not.toBe(input); // Enter blurred the field
    expect(onCommit).toHaveBeenCalledTimes(1); // committed via blur, not directly by the keydown too
    expect(onCommit).toHaveBeenCalledWith('PurchaseOrder');
  });

  test('Escape resets the DOM value to the committed value, blurs, and never commits', () => {
    const onCommit = vi.fn();
    const { container } = render(h(Field, { identity: 'id', value: 'Order', onCommit }));
    const input = getInput(container);

    type(input, 'Discarded');
    act(() => {
      fireEvent.keyDown(input, { key: 'Escape' });
    });

    expect(input.value).toBe('Order');
    expect(document.activeElement).not.toBe(input);
    expect(onCommit).not.toHaveBeenCalled();
  });

  test('blur with an unchanged value does not commit', () => {
    const onCommit = vi.fn();
    const { container } = render(h(Field, { identity: 'id', value: 'Order', onCommit }));
    const input = getInput(container);

    type(input, 'Order'); // unchanged
    act(() => input.blur());

    expect(onCommit).not.toHaveBeenCalled();
    expect(input.value).toBe('Order');
  });

  test('blur with a blank value does not commit and resets the DOM to the committed value', () => {
    const onCommit = vi.fn();
    const { container } = render(h(Field, { identity: 'id', value: 'Order', onCommit }));
    const input = getInput(container);

    type(input, '   ');
    act(() => input.blur());

    expect(onCommit).not.toHaveBeenCalled();
    expect(input.value).toBe('Order');
  });

  test('blur with a changed, non-blank value commits the trimmed text exactly once', () => {
    const onCommit = vi.fn();
    const { container } = render(h(Field, { identity: 'id', value: 'Order', onCommit }));
    const input = getInput(container);

    type(input, '  PurchaseOrder  ');
    act(() => input.blur());

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith('PurchaseOrder');
  });

  test('commitBlank: true lets a cleared field commit the empty string (the Description-clearing case)', () => {
    const onCommit = vi.fn();
    const { container } = render(
      h(Field, { identity: 'id', value: 'An old description.', onCommit, commitBlank: true }),
    );
    const input = getInput(container);

    type(input, '   ');
    act(() => input.blur());

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith('');
  });

  test('commitBlank: true still no-ops when the blank value is unchanged', () => {
    const onCommit = vi.fn();
    const { container } = render(h(Field, { identity: 'id', value: '', onCommit, commitBlank: true }));
    const input = getInput(container);

    type(input, '  ');
    act(() => input.blur());

    expect(onCommit).not.toHaveBeenCalled();
    expect(input.value).toBe('');
  });

  // The safety net (#992 colliding-key bug class, closed structurally): even when the caller does NOT
  // key the element on identity (no remount), an identity change must reset the DOM to the NEW
  // element's committed value — never leave the previous identity's uncommitted text behind for a later
  // blur to write to the wrong element.
  test('an identity change resets the field to the new value even without a remount (no key spread)', () => {
    const onCommit = vi.fn();
    const { container, rerender } = render(
      h(Field, { identity: 'Sales.Item', value: 'Item', onCommit, withKey: false }),
    );
    const input = getInput(container);

    // Type WITHOUT blurring, then move to a different identity that shares the same committed value —
    // the exact focus-retaining collision the #992 reviews caught twice.
    type(input, 'RenamedSalesItem');
    rerender(h(Field, { identity: 'Shipping.Item', value: 'Item', onCommit, withKey: false }));

    expect(getInput(container)).toBe(input); // same DOM node — no remount happened
    expect(input.value).toBe('Item'); // reset to the new identity's committed value

    act(() => input.blur());
    expect(onCommit).not.toHaveBeenCalled(); // the stale text never leaks to the new identity
  });

  test('a re-render with the SAME identity never clobbers in-progress typing', () => {
    const onCommit = vi.fn();
    const { container, rerender } = render(
      h(Field, { identity: 'Sales.Order', value: 'Order', onCommit, withKey: false }),
    );
    const input = getInput(container);

    type(input, 'InProgress');
    rerender(h(Field, { identity: 'Sales.Order', value: 'Order', onCommit, withKey: false }));

    expect(input.value).toBe('InProgress'); // the identity-reset effect must not fire for a mere re-render
  });

  test('with the key spread (the normal caller shape), an identity change remounts with the fresh value', () => {
    const onCommit = vi.fn();
    const { container, rerender } = render(h(Field, { identity: 'Sales.Item', value: 'Item', onCommit }));
    const input = getInput(container);

    type(input, 'RenamedSalesItem');
    rerender(h(Field, { identity: 'Shipping.Item', value: 'Item', onCommit }));

    const inputAfter = getInput(container);
    expect(inputAfter).not.toBe(input); // key change → remount
    expect(inputAfter.value).toBe('Item');
  });
});

// The transient-session mode (#1396): a caller that passes `onCancel` opts into "temporary row"
// semantics — the field is a session that must DISAPPEAR on cancel, not a persistent field that resets
// its DOM value. `validate`/`onInvalid` gate the commit: an invalid value keeps the edit open (Enter)
// or cancels the session (blur); a valid changed value commits exactly once. This is ExplorerPanel's
// inline create/rename editor generalized into the one blessed primitive.
function SessionField(props: {
  identity: string;
  value: string;
  onCommit: (next: string) => void;
  onCancel: () => void;
  onInvalid?: () => void;
  validate?: (trimmed: string) => boolean;
  commitBlank?: boolean;
}) {
  const field = useEditableField<HTMLInputElement>({
    identity: props.identity,
    value: props.value,
    onCommit: props.onCommit,
    onCancel: props.onCancel,
    onInvalid: props.onInvalid,
    validate: props.validate,
    commitBlank: props.commitBlank,
  });
  return h('input', { 'aria-label': 'field', ...field });
}

// A file-name-ish validator for the session tests: reject a segment containing a slash (mirrors
// ExplorerPanel's `invalidSegment` shape without importing it — the hook itself is domain-agnostic).
const noSlash = (s: string): boolean => !s.includes('/');

describe('useEditableField — transient-session mode (onCancel present)', () => {
  test('Enter with an invalid value keeps the edit open, fires onInvalid, and neither blurs nor commits', () => {
    const onCommit = vi.fn();
    const onCancel = vi.fn();
    const onInvalid = vi.fn();
    const { container } = render(
      h(SessionField, { identity: 'create:ROOT:file', value: '', onCommit, onCancel, onInvalid, validate: noSlash }),
    );
    const input = getInput(container);

    type(input, 'bad/name');
    act(() => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });

    expect(onInvalid).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(input); // edit stays open — never blurred
    expect(onCommit).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  test('Enter with a valid, changed value blurs and commits exactly once (via the blur handler)', () => {
    const onCommit = vi.fn();
    const onCancel = vi.fn();
    const { container } = render(
      h(SessionField, { identity: 'create:ROOT:file', value: '', onCommit, onCancel, validate: noSlash }),
    );
    const input = getInput(container);

    type(input, 'catalog.koi');
    act(() => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });

    expect(document.activeElement).not.toBe(input); // Enter blurred it
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith('catalog.koi');
    expect(onCancel).not.toHaveBeenCalled();
  });

  test('Escape cancels the session (onCancel), never commits', () => {
    const onCommit = vi.fn();
    const onCancel = vi.fn();
    const { container } = render(
      h(SessionField, { identity: 'rename:X', value: 'Order', onCommit, onCancel, validate: noSlash }),
    );
    const input = getInput(container);

    type(input, 'Whatever');
    act(() => {
      fireEvent.keyDown(input, { key: 'Escape' });
    });

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCommit).not.toHaveBeenCalled();
  });

  test('blur on a blank value cancels the session (onCancel), never commits', () => {
    const onCommit = vi.fn();
    const onCancel = vi.fn();
    const { container } = render(
      h(SessionField, { identity: 'create:ROOT:file', value: '', onCommit, onCancel, validate: noSlash }),
    );
    const input = getInput(container);

    type(input, '   ');
    act(() => input.blur());

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCommit).not.toHaveBeenCalled();
  });

  test('blur on an invalid value cancels the session (onCancel), never commits (no trap)', () => {
    const onCommit = vi.fn();
    const onCancel = vi.fn();
    const onInvalid = vi.fn();
    const { container } = render(
      h(SessionField, { identity: 'create:ROOT:file', value: '', onCommit, onCancel, onInvalid, validate: noSlash }),
    );
    const input = getInput(container);

    type(input, 'bad/name');
    act(() => input.blur());

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCommit).not.toHaveBeenCalled();
  });

  test('blur on a valid, changed value commits the trimmed text exactly once, never cancels', () => {
    const onCommit = vi.fn();
    const onCancel = vi.fn();
    const { container } = render(
      h(SessionField, { identity: 'create:ROOT:file', value: '', onCommit, onCancel, validate: noSlash }),
    );
    const input = getInput(container);

    type(input, '  catalog.koi  ');
    act(() => input.blur());

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith('catalog.koi');
    expect(onCancel).not.toHaveBeenCalled();
  });

  test('blur on a valid but UNCHANGED value cancels the session (no-op rename closes, skips commit)', () => {
    const onCommit = vi.fn();
    const onCancel = vi.fn();
    const { container } = render(
      h(SessionField, { identity: 'rename:X', value: 'Order', onCommit, onCancel, validate: noSlash }),
    );
    const input = getInput(container);

    type(input, 'Order'); // unchanged
    act(() => input.blur());

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCommit).not.toHaveBeenCalled();
  });

  test('blur on a DISCONNECTED element cancels the session and never commits (upstream removal mid-edit)', () => {
    const onCommit = vi.fn();
    const onCancel = vi.fn();
    const { container } = render(
      h(SessionField, { identity: 'rename:X', value: 'Order', onCommit, onCancel, validate: noSlash }),
    );
    const input = getInput(container);

    type(input, 'RenamedButGone'); // a valid, changed value — would otherwise commit
    input.remove(); // the entry vanished out from under the edit
    expect(input.isConnected).toBe(false);

    act(() => {
      input.dispatchEvent(new Event('blur'));
    });

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCommit).not.toHaveBeenCalled(); // never commit into a gone entry
  });

  // Regression: presence of `validate`/`onInvalid` WITHOUT `onCancel` must NOT switch modes — a caller
  // is in persistent mode iff `onCancel` is absent, and then the new params are inert (today's exact
  // behavior). Proven by an invalid value still riding the blur-commit path on Enter, exactly as before.
  describe('persistent mode (no onCancel) is unchanged even when validate/onInvalid are passed', () => {
    function PersistentWithValidate(props: {
      identity: string;
      value: string;
      onCommit: (next: string) => void;
      onInvalid?: () => void;
      validate?: (trimmed: string) => boolean;
    }) {
      const field = useEditableField<HTMLInputElement>({
        identity: props.identity,
        value: props.value,
        onCommit: props.onCommit,
        onInvalid: props.onInvalid,
        validate: props.validate,
      });
      return h('input', { 'aria-label': 'field', ...field });
    }

    test('Enter commits via blur and ignores validate/onInvalid (persistent field, not a session)', () => {
      const onCommit = vi.fn();
      const onInvalid = vi.fn();
      const { container } = render(
        h(PersistentWithValidate, { identity: 'id', value: 'Order', onCommit, onInvalid, validate: noSlash }),
      );
      const input = getInput(container);

      type(input, 'bad/name'); // would be rejected in session mode
      act(() => {
        fireEvent.keyDown(input, { key: 'Enter' });
      });

      expect(onInvalid).not.toHaveBeenCalled(); // validate is inert without onCancel
      expect(document.activeElement).not.toBe(input); // Enter still blurs (persistent behavior)
      expect(onCommit).toHaveBeenCalledTimes(1);
      expect(onCommit).toHaveBeenCalledWith('bad/name');
    });

    test('Escape resets the DOM value and blurs (persistent behavior), never cancels/commits', () => {
      const onCommit = vi.fn();
      const { container } = render(
        h(PersistentWithValidate, { identity: 'id', value: 'Order', onCommit, validate: noSlash }),
      );
      const input = getInput(container);

      type(input, 'Discarded');
      act(() => {
        fireEvent.keyDown(input, { key: 'Escape' });
      });

      expect(input.value).toBe('Order'); // reset to committed value (not removed)
      expect(document.activeElement).not.toBe(input);
      expect(onCommit).not.toHaveBeenCalled();
    });
  });
});
