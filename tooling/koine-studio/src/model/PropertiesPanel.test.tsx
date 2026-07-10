import { describe, expect, test, vi } from 'vitest';
import { act, fireEvent, render, waitFor } from '@testing-library/preact';
import { createAppStore } from '@/store/index';
import { useAppStore } from '@/store/hooks';
import { PropertiesPanel } from '@/model/PropertiesPanel';
import { buildModelIndex } from '@/model/modelIndex';
import type { DiagramNode, DocsFile, DocsResult, GlossaryEntry, GlossaryModel, Range } from '@/lsp/lsp';
import type { ChangeEntry } from '@/host/gitHistory';
import type { InspectorElement, InspectorHandlers } from '@/model/inspector';
import { axe } from 'vitest-axe';

const range: Range = { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } };

// Build a real joined index the same way modelIndex.test.ts does (buildModelIndex over a tiny glossary
// + a docs file with one diagram node), so the panel resolves a genuine element and renders real text.
function makeIndex() {
  const glossary: GlossaryModel = {
    entries: [
      { id: 'Sales', name: 'Sales', kind: 'context', context: 'Sales', qualifiedName: 'Sales', doc: null, nameRange: range },
      { id: 'Sales.Order', name: 'Order', kind: 'aggregate', context: 'Sales', qualifiedName: 'Sales.Order', doc: null, nameRange: range },
    ] satisfies GlossaryEntry[],
  };
  const orderNode: DiagramNode = {
    id: 'Sales.Order',
    label: 'Order',
    kind: 'aggregate',
    qualifiedName: 'Sales.Order',
    sourceSpan: null,
    stereotype: 'aggregate root',
    members: [{ text: 'id: OrderId', kind: 'field' }],
  };
  const file: DocsFile = {
    path: 'docs/x.md',
    contents: '',
    diagrams: [{ caption: 'c', kind: 'aggregate', mermaid: '', graph: { nodes: [orderNode], edges: [] } }],
  };
  const docs: DocsResult = { files: [file] };
  return buildModelIndex(glossary, docs);
}

// A richer index for the General/Properties/compartment tests: a documented Order aggregate with two
// plain fields, one computed field, one behavior, and one invariant — exercises every real (wired)
// compartment `buildInspectorElement` can populate. `publishedEvents`/`repository` stay unreachable
// through the real join (they are "reserved; not yet on the wire" per inspector.ts's own doc comment),
// so they are intentionally not exercised here — see the task-4 report for that accepted coverage note.
function makeRichIndex() {
  const glossary: GlossaryModel = {
    entries: [
      { id: 'Sales', name: 'Sales', kind: 'context', context: 'Sales', qualifiedName: 'Sales', doc: null, nameRange: range },
      {
        id: 'Sales.Order',
        name: 'Order',
        kind: 'aggregate',
        context: 'Sales',
        qualifiedName: 'Sales.Order',
        doc: 'A customer order.',
        nameRange: range,
      },
    ] satisfies GlossaryEntry[],
  };
  const orderNode: DiagramNode = {
    id: 'Sales.Order',
    label: 'Order',
    kind: 'aggregate',
    qualifiedName: 'Sales.Order',
    sourceSpan: null,
    stereotype: 'aggregate root',
    members: [
      { text: 'id: OrderId', kind: 'field' },
      { text: 'total: Money', kind: 'field' },
      { text: 'subtotal: Int', kind: 'computed' },
      { text: 'submit(): void', kind: 'method' },
    ],
    invariants: ['total >= 0'],
  };
  const file: DocsFile = {
    path: 'docs/x.md',
    contents: '',
    diagrams: [{ caption: 'c', kind: 'aggregate', mermaid: '', graph: { nodes: [orderNode], edges: [] } }],
  };
  return buildModelIndex(glossary, { files: [file] });
}

/** A single-element index whose only entry carries `kind` — enough to exercise the dataset.kind (DDD
 *  palette) mapping without a diagram node (the mapping reads only `entry.kind`). */
function indexWithKind(kind: string) {
  const glossary: GlossaryModel = {
    entries: [
      { id: 'Sales', name: 'Sales', kind: 'context', context: 'Sales', qualifiedName: 'Sales', doc: null, nameRange: range },
      { id: 'Sales.Thing', name: 'Thing', kind, context: 'Sales', qualifiedName: 'Sales.Thing', doc: null, nameRange: range },
    ] satisfies GlossaryEntry[],
  };
  return buildModelIndex(glossary, { files: [] });
}

/** Two distinct elements (different `qualifiedName`) that collide on Description — both undocumented,
 *  so `element.description` is `''` for each — to reproduce the #992 task-4 review's cross-element
 *  write-leak: a focus-retaining selection change between two elements sharing the same field VALUE
 *  must still remount the field (it's keyed on identity, not value). */
function makeDescriptionCollisionIndex() {
  const glossary: GlossaryModel = {
    entries: [
      { id: 'Sales', name: 'Sales', kind: 'context', context: 'Sales', qualifiedName: 'Sales', doc: null, nameRange: range },
      { id: 'Sales.Order', name: 'Order', kind: 'aggregate', context: 'Sales', qualifiedName: 'Sales.Order', doc: null, nameRange: range },
      { id: 'Sales.Payment', name: 'Payment', kind: 'aggregate', context: 'Sales', qualifiedName: 'Sales.Payment', doc: null, nameRange: range },
    ] satisfies GlossaryEntry[],
  };
  return buildModelIndex(glossary, { files: [] });
}

/** Two distinct elements (different `qualifiedName`, different bounded context) that collide on
 *  Name — both called "Item" — to reproduce the same write-leak class for the Name/rename field. */
function makeNameCollisionIndex() {
  const glossary: GlossaryModel = {
    entries: [
      { id: 'Sales', name: 'Sales', kind: 'context', context: 'Sales', qualifiedName: 'Sales', doc: null, nameRange: range },
      { id: 'Shipping', name: 'Shipping', kind: 'context', context: 'Shipping', qualifiedName: 'Shipping', doc: null, nameRange: range },
      { id: 'Sales.Item', name: 'Item', kind: 'aggregate', context: 'Sales', qualifiedName: 'Sales.Item', doc: null, nameRange: range },
      { id: 'Shipping.Item', name: 'Item', kind: 'aggregate', context: 'Shipping', qualifiedName: 'Shipping.Item', doc: null, nameRange: range },
    ] satisfies GlossaryEntry[],
  };
  return buildModelIndex(glossary, { files: [] });
}

/** Two distinct elements (different `qualifiedName`) whose Properties tables each contain a field
 *  named "code" (different types) — reproduces the same #992 task-4-review write-leak class, but for
 *  a property row's name/type editors rather than the General section: a focus-retaining selection
 *  change between two elements that happen to share a PROPERTY name must still remount that property's
 *  row (it's keyed on the owning element's identity combined with the property's own identity, not on
 *  the property name/type alone). */
function makePropertyNameCollisionIndex() {
  const glossary: GlossaryModel = {
    entries: [
      { id: 'Sales', name: 'Sales', kind: 'context', context: 'Sales', qualifiedName: 'Sales', doc: null, nameRange: range },
      { id: 'Sales.Order', name: 'Order', kind: 'aggregate', context: 'Sales', qualifiedName: 'Sales.Order', doc: null, nameRange: range },
      { id: 'Sales.Payment', name: 'Payment', kind: 'aggregate', context: 'Sales', qualifiedName: 'Sales.Payment', doc: null, nameRange: range },
    ] satisfies GlossaryEntry[],
  };
  const orderNode: DiagramNode = {
    id: 'Sales.Order',
    label: 'Order',
    kind: 'aggregate',
    qualifiedName: 'Sales.Order',
    sourceSpan: null,
    stereotype: 'aggregate root',
    members: [{ text: 'code: OrderCode', kind: 'field' }],
  };
  const paymentNode: DiagramNode = {
    id: 'Sales.Payment',
    label: 'Payment',
    kind: 'aggregate',
    qualifiedName: 'Sales.Payment',
    sourceSpan: null,
    stereotype: 'aggregate root',
    members: [{ text: 'code: PaymentCode', kind: 'field' }],
  };
  const file: DocsFile = {
    path: 'docs/x.md',
    contents: '',
    diagrams: [{ caption: 'c', kind: 'aggregate', mermaid: '', graph: { nodes: [orderNode, paymentNode], edges: [] } }],
  };
  return buildModelIndex(glossary, { files: [file] });
}

const handlers: InspectorHandlers = { onGoto: () => {} };

/** Render the panel over `makeRichIndex()` with `h`, then select Sales.Order (flushed via act()). */
function renderSelectedOrder(h: InspectorHandlers) {
  const store = createAppStore();
  const index = makeRichIndex();
  const utils = render(<PropertiesPanel store={store} index={index} handlers={h} />);
  act(() => store.getState().setSelection({ qualifiedName: 'Sales.Order', context: 'Sales' }));
  return { ...utils, store, index };
}

describe('PropertiesPanel', () => {
  test('renders the selected element name and re-renders when selection changes', () => {
    const store = createAppStore();
    const index = makeIndex();
    const { container } = render(<PropertiesPanel store={store} index={index} handlers={handlers} />);

    // Nothing selected yet → the inspector's empty state is mounted.
    expect(container.querySelector('.koi-inspector')).not.toBeNull();
    expect(container.textContent).not.toContain('Order');

    // Selecting an element re-renders the panel and shows the resolved element's name. The store
    // mutation is wrapped in act() so Preact flushes the (async-batched) re-render before we assert.
    act(() => store.getState().setSelection({ qualifiedName: 'Sales.Order', context: 'Sales' }));
    expect(container.textContent).toContain('Order');
  });

  test('does NOT re-render on an unrelated slice change (bottom tab)', () => {
    const store = createAppStore();
    const index = makeIndex();

    // A probe that subscribes to exactly the same slice the panel does. If an unrelated slice change
    // re-rendered selection subscribers, this counter would tick.
    const renders = vi.fn();
    function Probe() {
      useAppStore(store, (s) => s.selection);
      renders();
      return <PropertiesPanel store={store} index={index} handlers={handlers} />;
    }
    render(<Probe />);
    const before = renders.mock.calls.length;

    // An unrelated slice change must not re-render a selection subscriber (flushed via act()).
    act(() => store.getState().setBottom('events'));
    expect(renders.mock.calls.length).toBe(before); // no re-render

    // Sanity: a relevant change DOES re-render, proving the probe is actually wired.
    act(() => store.getState().setSelection({ qualifiedName: 'Sales.Order', context: 'Sales' }));
    expect(renders.mock.calls.length).toBeGreaterThan(before);
  });

  test('has no accessibility violations', async () => {
    const store = createAppStore();
    const index = makeIndex();
    const { container } = render(<PropertiesPanel store={store} index={index} handlers={handlers} />);
    act(() => store.getState().setSelection({ qualifiedName: 'Sales.Order', context: 'Sales' }));
    expect(await axe(container)).toHaveNoViolations();
  });

  test('renders the empty state (no data-qname) when nothing is selected', () => {
    const store = createAppStore();
    const index = makeIndex();
    const { container } = render(<PropertiesPanel store={store} index={index} handlers={handlers} />);

    const root = container.querySelector('.koi-inspector')!;
    expect(root.getAttribute('data-qname')).toBeNull();
    expect(root.querySelector('.koi-rview-empty-title')!.textContent).toBe('Properties');
    expect(root.textContent).toMatch(/select an element/i);
  });

  test('header: the name button jumps to the declaration, and shows the stereotype + qualified name', () => {
    const onGoto = vi.fn();
    const { container } = renderSelectedOrder({ onGoto });

    const nameBtn = container.querySelector<HTMLButtonElement>('.koi-inspector-name')!;
    expect(nameBtn.textContent).toBe('Order');
    expect(nameBtn.getAttribute('aria-label')).toBe('Go to declaration: Order');
    fireEvent.click(nameBtn);
    expect(onGoto).toHaveBeenCalledWith(range);

    expect(container.querySelector('.koi-inspector-stereotype')!.textContent).toBe('aggregate root');
    expect(container.querySelector('.koi-inspector-qname')!.textContent).toBe('Sales.Order');
  });

  test.each([
    ['aggregate', 'aggregate'],
    ['quantity', 'value'],
    ['integration event', 'integration-event'],
    ['service', 'type'],
    ['unknown-kind', 'type'],
  ])('data-kind reflects the DDD-palette mapping of kind %s → %s', (kind, expected) => {
    const store = createAppStore();
    const index = indexWithKind(kind);
    const { container } = render(<PropertiesPanel store={store} index={index} handlers={handlers} />);
    act(() => store.getState().setSelection({ qualifiedName: 'Sales.Thing', context: 'Sales' }));
    expect(container.querySelector('.koi-inspector')!.getAttribute('data-kind')).toBe(expected);
    expect(container.querySelector('.koi-inspector')!.getAttribute('data-qname')).toBe('Sales.Thing');
  });

  describe('General — Name', () => {
    test('the Name field is id/name/label-associated and seeded with the element name (#642 regression class)', () => {
      const { container } = renderSelectedOrder(handlers);
      const input = container.querySelector<HTMLInputElement>('#koi-insp-name')!;
      expect(input).not.toBeNull();
      expect(input.name).toBe('koi-insp-name');
      expect(input.value).toBe('Order');
      const label = container.querySelector<HTMLLabelElement>('label[for="koi-insp-name"]')!;
      expect(label.querySelector('.koi-inspector-field-label')!.textContent).toBe('Name');
      expect(label.contains(input)).toBe(true);
    });

    test('commits a changed name on blur; leaves an unchanged/blank name uncommitted and reset', () => {
      const onRename = vi.fn();
      const { container } = renderSelectedOrder({ onGoto: () => {}, onRename });
      const input = container.querySelector<HTMLInputElement>('#koi-insp-name')!;

      act(() => input.focus()); // .blur() below is a no-op unless the node is actually focused
      input.value = 'PurchaseOrder';
      act(() => {
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.blur();
      });
      expect(onRename).toHaveBeenCalledWith(expect.objectContaining({ name: 'Order' }), 'PurchaseOrder');

      onRename.mockClear();
      act(() => input.focus());
      input.value = 'Order'; // back to the original
      act(() => {
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.blur();
      });
      expect(onRename).not.toHaveBeenCalled();
      expect(input.value).toBe('Order');
    });

    test('Enter blurs (and commits a changed value)', () => {
      const onRename = vi.fn();
      const { container } = renderSelectedOrder({ onGoto: () => {}, onRename });
      const input = container.querySelector<HTMLInputElement>('#koi-insp-name')!;
      act(() => input.focus());
      input.value = 'PurchaseOrder';
      act(() => {
        input.dispatchEvent(new Event('input', { bubbles: true }));
        fireEvent.keyDown(input, { key: 'Enter' });
      });
      expect(onRename).toHaveBeenCalledWith(expect.objectContaining({ name: 'Order' }), 'PurchaseOrder');
    });

    test('Escape reverts the typed value and does not commit', () => {
      const onRename = vi.fn();
      const { container } = renderSelectedOrder({ onGoto: () => {}, onRename });
      const input = container.querySelector<HTMLInputElement>('#koi-insp-name')!;
      act(() => input.focus());
      input.value = 'Discarded';
      act(() => {
        input.dispatchEvent(new Event('input', { bubbles: true }));
        fireEvent.keyDown(input, { key: 'Escape' });
      });
      expect(input.value).toBe('Order');
      expect(onRename).not.toHaveBeenCalled();
    });

    // #992 task-4 review: the Name input used to be keyed on `element.name` (the field's own VALUE).
    // Two distinct elements that happen to share a name (e.g. "Item" in two different bounded contexts)
    // would then NOT remount the field on a focus-retaining selection change (no blur in between —
    // keyboard nav or an outline click that doesn't blur the input) — so the stale, uncommitted DOM
    // value from the first element survives, and a later blur would attribute it to the SECOND element.
    // Keying on `element.qualifiedName` (a stable per-element identity) fixes this: this test fails
    // (stays on 'RenamedSalesItem', or fires onRename) if the key regresses back to `element.name`.
    test('remounts (resets) the Name field on a focus-retaining selection change to a different element sharing the same name (cross-element rename write-leak regression, #992 task-4 review)', () => {
      const store = createAppStore();
      const index = makeNameCollisionIndex();
      const onRename = vi.fn();
      const { container } = render(
        <PropertiesPanel store={store} index={index} handlers={{ onGoto: () => {}, onRename }} />,
      );
      act(() => store.getState().setSelection({ qualifiedName: 'Sales.Item', context: 'Sales' }));

      const input = container.querySelector<HTMLInputElement>('#koi-insp-name')!;
      expect(input.value).toBe('Item');

      // Type into the field WITHOUT blurring.
      act(() => input.focus());
      input.value = 'RenamedSalesItem';
      act(() => {
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });

      // Selection moves to a DIFFERENT element (different qualifiedName/context) that happens to share
      // the same current name ("Item") — no blur fired in between, simulating a focus-retaining
      // selection change (e.g. keyboard navigation in the outline).
      act(() => store.getState().setSelection({ qualifiedName: 'Shipping.Item', context: 'Shipping' }));

      const inputAfter = container.querySelector<HTMLInputElement>('#koi-insp-name')!;
      expect(inputAfter.value).toBe('Item'); // reset to Shipping.Item's own name, not the stale typed text

      // Blurring now must not attribute Sales.Item's uncommitted text to Shipping.Item.
      act(() => inputAfter.blur());
      expect(onRename).not.toHaveBeenCalled();
    });
  });

  describe('General — Description', () => {
    test('the Description field is id/name/label-associated and seeded (#642 regression class)', () => {
      const { container } = renderSelectedOrder(handlers);
      const textarea = container.querySelector<HTMLTextAreaElement>('#koi-insp-description')!;
      expect(textarea).not.toBeNull();
      expect(textarea.tagName).toBe('TEXTAREA');
      expect(textarea.name).toBe('koi-insp-description');
      expect(textarea.value).toBe('A customer order.');
      const label = container.querySelector<HTMLLabelElement>('label[for="koi-insp-description"]')!;
      expect(label.contains(textarea)).toBe(true);
    });

    test('commits a changed description on blur; an unchanged one does not commit', () => {
      const onSaveDescription = vi.fn();
      const { container } = renderSelectedOrder({ onGoto: () => {}, onSaveDescription });
      const textarea = container.querySelector<HTMLTextAreaElement>('#koi-insp-description')!;

      act(() => textarea.focus());
      textarea.value = 'An order placed by a customer.';
      act(() => {
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        textarea.blur();
      });
      expect(onSaveDescription).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Order' }),
        'An order placed by a customer.',
      );

      onSaveDescription.mockClear();
      act(() => textarea.focus());
      textarea.value = 'A customer order.'; // back to the original — an unchanged commit
      act(() => {
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        textarea.blur();
      });
      expect(onSaveDescription).not.toHaveBeenCalled();
    });

    // #992 task-4 review: the Description textarea used to be keyed on `element.description ?? ''`
    // (the field's own VALUE). Two distinct, undocumented elements (both `description === ''`) would
    // then NOT remount the field on a focus-retaining selection change (no blur in between) — so a
    // stale, uncommitted edit typed for the FIRST element survives in the DOM, and a later blur would
    // attribute it to the SECOND element via `onSaveDescription`. Keying on `element.qualifiedName`
    // fixes this: this test fails (stays on the stale text, or fires onSaveDescription) if the key
    // regresses back to a value-derived key.
    test('remounts (resets) the Description field on a focus-retaining selection change to a different element sharing the same description (cross-element write-leak regression, #992 task-4 review)', () => {
      const store = createAppStore();
      const index = makeDescriptionCollisionIndex();
      const onSaveDescription = vi.fn();
      const { container } = render(
        <PropertiesPanel store={store} index={index} handlers={{ onGoto: () => {}, onSaveDescription }} />,
      );
      act(() => store.getState().setSelection({ qualifiedName: 'Sales.Order', context: 'Sales' }));

      const textarea = container.querySelector<HTMLTextAreaElement>('#koi-insp-description')!;
      expect(textarea.value).toBe(''); // Order is undocumented

      // Type into the field WITHOUT blurring — a focus-retaining selection change (e.g. keyboard
      // navigation in the outline, or an outline click that doesn't blur the textarea) can move the
      // selection while this text is still uncommitted.
      act(() => textarea.focus());
      textarea.value = 'Uncommitted note meant for Order';
      act(() => {
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
      });

      // Selection moves to a DIFFERENT element that happens to share the same ('') description — still
      // no blur fired.
      act(() => store.getState().setSelection({ qualifiedName: 'Sales.Payment', context: 'Sales' }));

      const textareaAfter = container.querySelector<HTMLTextAreaElement>('#koi-insp-description')!;
      expect(textareaAfter.value).toBe(''); // reset to Payment's own description, not the stale typed text

      // Blurring now must not attribute Order's uncommitted text to Payment.
      act(() => textareaAfter.blur());
      expect(onSaveDescription).not.toHaveBeenCalled();
    });
  });

  describe('Properties table', () => {
    test('computed rows stay read-only (no input) while plain fields are editable', () => {
      const h: InspectorHandlers = {
        onGoto: () => {},
        onRenameProperty: vi.fn(),
        onChangeType: vi.fn(),
        onRemoveProperty: vi.fn(),
      };
      const { container } = renderSelectedOrder(h);
      const editableRows = container.querySelectorAll('.koi-inspector-row-editable');
      expect(editableRows.length).toBe(2); // id, total — NOT the computed subtotal

      const computed = container.querySelector('.koi-inspector-row-computed')!;
      expect(computed.querySelector('input')).toBeNull();
      expect(computed.querySelector('.koi-inspector-prop-name')!.textContent).toBe('subtotal');
      expect(computed.querySelector('.koi-inspector-prop-type')!.textContent).toBe('Int');
    });

    test('renders properties as row-scoped table headers', () => {
      const { container } = renderSelectedOrder(handlers);
      const rows = Array.from(container.querySelectorAll<HTMLTableRowElement>('.koi-inspector-table tr'));
      expect(rows.map((tr) => tr.querySelector('th')?.getAttribute('scope'))).toEqual(['row', 'row', 'row']);
    });

    test('committing a changed property name calls onRenameProperty with the old + new names', () => {
      const onRenameProperty = vi.fn();
      const { container } = renderSelectedOrder({ onGoto: () => {}, onRenameProperty });
      const nameInput = container.querySelector<HTMLInputElement>(
        '.koi-inspector-row-editable .koi-inspector-prop-name input',
      )!;
      act(() => nameInput.focus()); // .blur() below is a no-op unless the node is actually focused
      nameInput.value = 'identifier';
      act(() => {
        nameInput.dispatchEvent(new Event('input', { bubbles: true }));
        nameInput.blur();
      });
      expect(onRenameProperty).toHaveBeenCalledWith(expect.objectContaining({ name: 'Order' }), 'id', 'identifier');
    });

    test('an unchanged property input does not fire an edit', () => {
      const onRenameProperty = vi.fn();
      const { container } = renderSelectedOrder({ onGoto: () => {}, onRenameProperty });
      const nameInput = container.querySelector<HTMLInputElement>(
        '.koi-inspector-row-editable .koi-inspector-prop-name input',
      )!;
      act(() => nameInput.focus());
      act(() => nameInput.blur()); // untouched
      expect(onRenameProperty).not.toHaveBeenCalled();
    });

    // The Task-1-review bug class: Escape must revert to the CURRENT value, not a stale one.
    test('Escape reverts an in-progress property edit and does not commit', () => {
      const onRenameProperty = vi.fn();
      const { container } = renderSelectedOrder({ onGoto: () => {}, onRenameProperty });
      const nameInput = container.querySelector<HTMLInputElement>(
        '.koi-inspector-row-editable .koi-inspector-prop-name input',
      )!;
      act(() => nameInput.focus());
      nameInput.value = 'discarded';
      act(() => {
        nameInput.dispatchEvent(new Event('input', { bubbles: true }));
        fireEvent.keyDown(nameInput, { key: 'Escape' });
      });
      expect(nameInput.value).toBe('id');
      expect(onRenameProperty).not.toHaveBeenCalled();
    });

    test('committing a changed property type calls onChangeType; the type input carries the datalist `list`', () => {
      const onChangeType = vi.fn();
      const { container } = renderSelectedOrder({ onGoto: () => {}, onChangeType });
      const typeInput = container.querySelector<HTMLInputElement>(
        '.koi-inspector-row-editable .koi-inspector-prop-type input',
      )!;
      expect(typeInput.getAttribute('list')).toBe('koi-inspector-type-options');
      act(() => typeInput.focus());
      typeInput.value = 'OrderNumber';
      act(() => {
        typeInput.dispatchEvent(new Event('input', { bubbles: true }));
        typeInput.blur();
      });
      expect(onChangeType).toHaveBeenCalledWith(expect.objectContaining({ name: 'Order' }), 'id', 'OrderNumber');
    });

    test('the delete button calls onRemoveProperty with the property name', () => {
      const onRemoveProperty = vi.fn();
      const { container } = renderSelectedOrder({ onGoto: () => {}, onRemoveProperty });
      const del = container.querySelector<HTMLButtonElement>('.koi-inspector-row-editable .koi-inspector-prop-delete')!;
      expect(del.getAttribute('aria-label')).toBe('Remove property id');
      fireEvent.click(del);
      expect(onRemoveProperty).toHaveBeenCalledWith(expect.objectContaining({ name: 'Order' }), 'id');
    });

    test('the add-property row requires both fields, then clears and refocuses the name field', () => {
      const onAddProperty = vi.fn();
      const { container } = renderSelectedOrder({ onGoto: () => {}, onAddProperty });
      const name = container.querySelector<HTMLInputElement>('.koi-inspector-add-name')!;
      const type = container.querySelector<HTMLInputElement>('.koi-inspector-add-type')!;
      const add = container.querySelector<HTMLButtonElement>('.koi-inspector-add-btn')!;
      expect(type.getAttribute('list')).toBe('koi-inspector-type-options');

      fireEvent.click(add); // both empty → no-op
      expect(onAddProperty).not.toHaveBeenCalled();

      name.value = 'quantity';
      type.value = 'Int';
      act(() => {
        name.dispatchEvent(new Event('input', { bubbles: true }));
        type.dispatchEvent(new Event('input', { bubbles: true }));
      });
      fireEvent.click(add);
      expect(onAddProperty).toHaveBeenCalledWith(expect.objectContaining({ name: 'Order' }), 'quantity', 'Int');
      expect(name.value).toBe('');
      expect(type.value).toBe('');
      expect(document.activeElement).toBe(name);
    });

    test('with no editing handlers the Properties table stays fully read-only', () => {
      const { container } = renderSelectedOrder({ onGoto: () => {} });
      expect(container.querySelector('.koi-inspector-row-editable')).toBeNull();
      expect(container.querySelector('.koi-inspector-prop-input')).toBeNull();
      expect(container.querySelector('.koi-inspector-add-prop')).toBeNull();
      expect(container.querySelector('.koi-inspector-table')!.classList.contains('koi-inspector-table-editable')).toBe(
        false,
      );
    });

    // Final #992 review, Finding 1: EditablePropertyRow (and its nested EditableRow name/type inputs)
    // used to be keyed on the property's own name/type VALUE, not on the OWNING ELEMENT's identity —
    // the same write-leak class the General section's Name/Description fields were fixed for (task-4
    // review, commit 4631c4d7). Two elements with a same-named property reused the same row/input across
    // a focus-retaining selection change (no blur in between), so an uncommitted edit typed for the first
    // element could commit onto the second on blur. Keying on `${element.qualifiedName}:${name}` forces
    // a remount on any selection change while staying stable across re-renders of the SAME element/property.
    test('remounts (resets) a property row on a focus-retaining selection change to a different element sharing the same property name (cross-element property write-leak regression, final #992 review Finding 1)', () => {
      const store = createAppStore();
      const index = makePropertyNameCollisionIndex();
      const onRenameProperty = vi.fn();
      const { container } = render(
        <PropertiesPanel store={store} index={index} handlers={{ onGoto: () => {}, onRenameProperty }} />,
      );
      act(() => store.getState().setSelection({ qualifiedName: 'Sales.Order', context: 'Sales' }));

      const nameInput = () =>
        container.querySelector<HTMLInputElement>('.koi-inspector-row-editable .koi-inspector-prop-name input')!;
      expect(nameInput().value).toBe('code');

      // Type into Order's "code" name field WITHOUT blurring.
      act(() => nameInput().focus());
      nameInput().value = 'renamedByOrder';
      act(() => {
        nameInput().dispatchEvent(new Event('input', { bubbles: true }));
      });

      // Selection moves to a DIFFERENT element (Payment) that happens to have a property with the SAME
      // name ("code") — no blur fired in between, simulating a focus-retaining selection change.
      act(() => store.getState().setSelection({ qualifiedName: 'Sales.Payment', context: 'Sales' }));

      const inputAfter = nameInput();
      expect(inputAfter.value).toBe('code'); // reset to Payment's own "code", not Order's stale typed text

      // Blurring now must not attribute Order's uncommitted text to Payment.
      act(() => inputAfter.blur());
      expect(onRenameProperty).not.toHaveBeenCalled();
    });
  });

  test('lists the wired compartments (Behaviors, Invariants) and omits the never-populated ones (Published Events, Repository)', () => {
    const { container } = renderSelectedOrder(handlers);
    const headers = Array.from(container.querySelectorAll('.koi-inspector-section-title')).map((n) => n.textContent);
    expect(headers).toEqual(expect.arrayContaining(['General', 'Properties', 'Behaviors', 'Invariants']));
    expect(headers).not.toContain('Published Events');
    expect(headers).not.toContain('Repository');
    expect(container.textContent).toContain('submit(): void');
    expect(container.textContent).toContain('total >= 0');
  });

  describe('Change history', () => {
    const entries: ChangeEntry[] = [
      { sha: 'a1b2c3d', author: 'Alice Dupont', date: '2026-06-20T10:30:00+02:00', message: 'Add the Rule invariant' },
      { sha: 'e4f5g6h', author: 'Bob', date: '2026-05-01T09:00:00Z', message: 'Introduce Order aggregate' },
    ];

    test('renders resolved entries with data-sha and a YYYY-MM-DD date, newest first', async () => {
      const loadHistory = vi.fn(async () => entries);
      const { container } = renderSelectedOrder({ onGoto: () => {}, loadHistory });
      await waitFor(() => expect(container.querySelector('.koi-inspector-history')).not.toBeNull());
      const rows = Array.from(container.querySelectorAll('.koi-inspector-history-item'));
      expect(rows.length).toBe(2);
      expect((rows[0] as HTMLElement).dataset.sha).toBe('a1b2c3d');
      expect(rows[0].querySelector('.koi-inspector-history-meta')!.textContent).toBe('Alice Dupont · 2026-06-20');
      expect(rows[0].querySelector('.koi-inspector-history-message')!.textContent).toBe('Add the Rule invariant');
    });

    test('renders nothing when loadHistory resolves null', async () => {
      const loadHistory = vi.fn(async () => null);
      const { container } = renderSelectedOrder({ onGoto: () => {}, loadHistory });
      await waitFor(() => expect(loadHistory).toHaveBeenCalled());
      expect(container.querySelector('.koi-inspector-history')).toBeNull();
    });

    test('a resolve that arrives after the selection moved on appends nothing (stale-selection guard)', async () => {
      const store = createAppStore();
      const index = makeRichIndex();
      // Extend the index with a second, unrelated element to move the selection to.
      index.byQn.set('Sales.Payment', {
        entry: {
          id: 'Sales.Payment',
          name: 'Payment',
          kind: 'aggregate',
          context: 'Sales',
          qualifiedName: 'Sales.Payment',
          doc: null,
          nameRange: range,
        },
      });

      let resolveOrder!: (v: ChangeEntry[] | null) => void;
      let resolvePayment!: (v: ChangeEntry[] | null) => void;
      const loadHistory = vi.fn((el: InspectorElement) => {
        if (el.qualifiedName === 'Sales.Order') return new Promise<ChangeEntry[] | null>((r) => (resolveOrder = r));
        return new Promise<ChangeEntry[] | null>((r) => (resolvePayment = r));
      });
      const h: InspectorHandlers = { onGoto: () => {}, loadHistory };
      const { container } = render(<PropertiesPanel store={store} index={index} handlers={h} />);

      act(() => store.getState().setSelection({ qualifiedName: 'Sales.Order', context: 'Sales' }));
      await waitFor(() => expect(loadHistory).toHaveBeenCalledWith(expect.objectContaining({ qualifiedName: 'Sales.Order' })));

      act(() => store.getState().setSelection({ qualifiedName: 'Sales.Payment', context: 'Sales' }));
      await waitFor(() =>
        expect(loadHistory).toHaveBeenCalledWith(expect.objectContaining({ qualifiedName: 'Sales.Payment' })),
      );

      // The stale Order resolve arrives after the selection already moved to Payment.
      await act(async () => {
        resolveOrder([{ sha: 'stale01', author: 'A', date: '2026-01-01T00:00:00Z', message: 'stale entry' }]);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(container.querySelector('.koi-inspector-history')).toBeNull();
      expect(container.textContent).not.toContain('stale entry');

      // Payment's own resolve DOES render — proving the guard isn't just permanently broken.
      act(() => resolvePayment([{ sha: 'fresh01', author: 'B', date: '2026-02-02T00:00:00Z', message: 'fresh entry' }]));
      await waitFor(() => expect(container.querySelector('.koi-inspector-history')).not.toBeNull());
      expect(container.textContent).toContain('fresh entry');
      expect(container.textContent).not.toContain('stale entry');
    });
  });
});
