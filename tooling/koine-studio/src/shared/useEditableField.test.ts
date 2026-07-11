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
