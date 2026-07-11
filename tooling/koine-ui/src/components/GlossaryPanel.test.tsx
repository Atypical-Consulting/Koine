import { describe, expect, test, vi } from 'vitest';
import { act, fireEvent, render, within } from '@testing-library/preact';
import { axe } from 'vitest-axe';
import {
  GlossaryPanel,
  type GlossaryEntryView,
  type GlossaryGroupView,
  type GlossaryPanelSlice,
  type GlossaryRange,
} from './GlossaryPanel';
import { GlossaryPanel as GlossaryPanelFromBarrel } from '../index';
import { createTestReadableStore } from '../host/storeTestUtils';

const range = (line = 0): GlossaryRange => ({ start: { line, character: 0 }, end: { line, character: 4 } });

const entry = (
  name: string,
  context: string,
  kind = 'value',
  doc: string | null = null,
  nameRange: GlossaryRange = range(),
): GlossaryEntryView => ({
  id: `${context}.${name}`,
  name,
  kind,
  context,
  qualifiedName: `${context}.${name}`,
  doc,
  nameRange,
});

// Build a slice the way the host adapter would: group by context (declaration order) + compute coverage.
function sliceOf(entries: GlossaryEntryView[]): GlossaryPanelSlice {
  const groups: GlossaryGroupView[] = [];
  for (const e of entries) {
    let g = groups.find((x) => x.context === e.context);
    if (!g) {
      g = { context: e.context, entries: [] };
      groups.push(g);
    }
    g.entries.push(e);
  }
  const documented = entries.filter((e) => e.doc != null && e.doc.trim().length > 0).length;
  const total = entries.length;
  const pct = total === 0 ? 0 : Math.round((documented / total) * 100);
  return { groups, coverage: { documented, total, pct } };
}

const noopHandlers = { onGoto: () => {}, onSave: () => {} };

describe('GlossaryPanel', () => {
  // A two-context glossary: Sales owns Order, Inv owns Stock. A host scope change to "Sales" drops Stock.
  const twoContexts = [entry('Order', 'Sales'), entry('Stock', 'Inv')];

  test('exports the same component from the barrel', () => {
    expect(GlossaryPanelFromBarrel).toBe(GlossaryPanel);
  });

  test('renders every context’s concepts, and a host scope change (set) narrows them', () => {
    const store = createTestReadableStore<GlossaryPanelSlice>(sliceOf(twoContexts));
    const { container } = render(<GlossaryPanel store={store} handlers={noopHandlers} />);

    // Unscoped → both contexts' concepts present.
    expect(container.textContent).toContain('Order');
    expect(container.textContent).toContain('Stock');

    // A host notification narrows to Sales (flushed via act()) and drops the Inv concept.
    act(() => store.set(sliceOf([entry('Order', 'Sales')])));
    expect(container.textContent).toContain('Order');
    expect(container.textContent).not.toContain('Stock');
  });

  test('scrolls the targeted term into view when a scroll target is given (#1165)', () => {
    const store = createTestReadableStore<GlossaryPanelSlice>(sliceOf(twoContexts));
    const scrolled: Element[] = [];
    const orig = Element.prototype.scrollIntoView;
    // happy-dom doesn't implement scrollIntoView; install a spy that records the element it lands on.
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
    try {
      render(<GlossaryPanel store={store} handlers={noopHandlers} scrollToTerm="Sales.Order" scrollNonce={1} />);
      // The Order entry (data-qn="Sales.Order") is the one scrolled into view — not the whole panel.
      expect(scrolled.some((e) => e.getAttribute('data-qn') === 'Sales.Order')).toBe(true);
    } finally {
      Element.prototype.scrollIntoView = orig;
    }
  });

  test('has no accessibility violations', async () => {
    const store = createTestReadableStore<GlossaryPanelSlice>(sliceOf(twoContexts));
    const { container } = render(<GlossaryPanel store={store} handlers={noopHandlers} />);
    expect(await axe(container)).toHaveNoViolations();
  });

  // The coverage gauge, declaration ordering, and the inline description editor (Edit/Save/Cancel/Escape/
  // Cmd-Enter) — the editor's stale-prop-revert invariants are also pinned generically in
  // useCommittableField.test.ts; these assert them through the panel's rendered markup.
  describe('coverage gauge, ordering, and the inline description editor', () => {
    const editorEntries = (): GlossaryEntryView[] => [
      entry('Ordering', 'Ordering', 'context', 'The ordering context.'),
      entry('Money', 'Ordering', 'value', 'A monetary amount.', range(3)),
      entry('Currency', 'Ordering', 'enum', null),
    ];
    const store = () => createTestReadableStore<GlossaryPanelSlice>(sliceOf(editorEntries()));

    const entryRow = (container: Element, index: number) =>
      container.querySelectorAll<HTMLElement>('.koi-gloss-entry')[index];

    test('renders a coverage gauge with the documented count and bar width', () => {
      const { container } = render(<GlossaryPanel store={store()} handlers={noopHandlers} />);
      expect(container.querySelector('.koi-gloss-coverage')!.textContent).toContain('2 / 3 documented · 67%');
      expect((container.querySelector('.koi-gloss-bar-fill') as HTMLElement).style.width).toBe('67%');
    });

    test('renders the context entry first, then its types, each with its kind badge', () => {
      const { container } = render(<GlossaryPanel store={store()} handlers={noopHandlers} />);
      const names = Array.from(container.querySelectorAll('.koi-gloss-name')).map((n) => n.textContent);
      expect(names).toEqual(['Ordering', 'Money', 'Currency']);
      const kinds = Array.from(container.querySelectorAll('.koi-gloss-kind')).map((n) => n.textContent);
      expect(kinds).toEqual(['context', 'value', 'enum']);
    });

    test('each entry carries its qualified-name anchor (data-qn) for scroll-to-term (#1165)', () => {
      const { container } = render(<GlossaryPanel store={store()} handlers={noopHandlers} />);
      const anchors = Array.from(container.querySelectorAll('.koi-gloss-entry')).map((e) => e.getAttribute('data-qn'));
      expect(anchors).toEqual(['Ordering.Ordering', 'Ordering.Money', 'Ordering.Currency']);
    });

    test('shows the doc for documented entries and a prompt for undocumented ones', () => {
      const { container } = render(<GlossaryPanel store={store()} handlers={noopHandlers} />);
      const moneyRow = entryRow(container, 1);
      expect(moneyRow.querySelector('.koi-gloss-doc')!.textContent).toContain('A monetary amount.');
      expect(container.querySelector('.koi-gloss-needsdoc')!.textContent).toBe('Needs description');
    });

    test('clicking a name jumps to its source range', () => {
      const onGoto = vi.fn();
      const { container } = render(<GlossaryPanel store={store()} handlers={{ ...noopHandlers, onGoto }} />);
      fireEvent.click(entryRow(container, 1).querySelector<HTMLButtonElement>('.koi-gloss-name')!); // Money
      expect(onGoto).toHaveBeenCalledWith(range(3));
    });

    test('Edit opens a focused textarea seeded with the current description', () => {
      const { container } = render(<GlossaryPanel store={store()} handlers={noopHandlers} />);
      const moneyRow = entryRow(container, 1);
      fireEvent.click(within(moneyRow).getByRole('button', { name: 'Edit description for Money' }));

      const textarea = within(moneyRow).getByRole('textbox') as HTMLTextAreaElement;
      expect(textarea.value).toBe('A monetary amount.');
      expect(document.activeElement).toBe(textarea);
    });

    test('Save calls onSave and closes back to the read view with the new text', () => {
      const onSave = vi.fn();
      const { container } = render(<GlossaryPanel store={store()} handlers={{ ...noopHandlers, onSave }} />);
      const currencyRow = entryRow(container, 2); // undocumented enum
      const addBtn = within(currencyRow).getByRole('button', { name: 'Add description for Currency' });
      expect(addBtn.textContent).toBe('Add description');
      fireEvent.click(addBtn);

      const input = within(currencyRow).getByRole('textbox') as HTMLTextAreaElement;
      fireEvent.input(input, { target: { value: 'The currency of an amount.' } });
      fireEvent.click(within(currencyRow).getByRole('button', { name: 'Save description for Currency' }));

      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Currency' }),
        'The currency of an amount.',
      );
      expect(currencyRow.querySelector('.koi-gloss-input')).toBeNull(); // editor closed
      expect(currencyRow.querySelector('.koi-gloss-doc')!.textContent).toContain('The currency of an amount.');
    });

    test('Cancel discards the edit without calling onSave', () => {
      const onSave = vi.fn();
      const { container } = render(<GlossaryPanel store={store()} handlers={{ ...noopHandlers, onSave }} />);
      const currencyRow = entryRow(container, 2);
      fireEvent.click(within(currencyRow).getByRole('button', { name: 'Add description for Currency' }));
      const input = within(currencyRow).getByRole('textbox') as HTMLTextAreaElement;
      fireEvent.input(input, { target: { value: 'nope' } });
      fireEvent.click(within(currencyRow).getByRole('button', { name: 'Cancel editing description for Currency' }));

      expect(onSave).not.toHaveBeenCalled();
      expect(currencyRow.querySelector('.koi-gloss-input')).toBeNull();
      expect(currencyRow.querySelector('.koi-gloss-needsdoc')).not.toBeNull();
    });

    test('Escape reverts the edit without calling onSave', () => {
      const onSave = vi.fn();
      const { container } = render(<GlossaryPanel store={store()} handlers={{ ...noopHandlers, onSave }} />);
      const moneyRow = entryRow(container, 1); // already documented
      fireEvent.click(within(moneyRow).getByRole('button', { name: 'Edit description for Money' }));
      const input = within(moneyRow).getByRole('textbox') as HTMLTextAreaElement;
      fireEvent.input(input, { target: { value: 'a discarded draft' } });
      fireEvent.keyDown(input, { key: 'Escape' });

      expect(onSave).not.toHaveBeenCalled();
      expect(moneyRow.querySelector('.koi-gloss-input')).toBeNull();
      expect(moneyRow.querySelector('.koi-gloss-doc')!.textContent).toContain('A monetary amount.');
    });

    test('Cmd+Enter and Ctrl+Enter in the textarea both commit the edit', () => {
      const onSave = vi.fn();
      const { container } = render(<GlossaryPanel store={store()} handlers={{ ...noopHandlers, onSave }} />);
      const currencyRow = entryRow(container, 2);

      fireEvent.click(within(currencyRow).getByRole('button', { name: 'Add description for Currency' }));
      let input = within(currencyRow).getByRole('textbox') as HTMLTextAreaElement;
      fireEvent.input(input, { target: { value: 'Committed via Cmd+Enter.' } });
      fireEvent.keyDown(input, { key: 'Enter', metaKey: true });
      expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ name: 'Currency' }), 'Committed via Cmd+Enter.');
      expect(currencyRow.querySelector('.koi-gloss-input')).toBeNull();

      fireEvent.click(within(currencyRow).getByRole('button', { name: 'Edit description for Currency' }));
      input = within(currencyRow).getByRole('textbox') as HTMLTextAreaElement;
      fireEvent.input(input, { target: { value: 'Committed via Ctrl+Enter.' } });
      fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
      expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ name: 'Currency' }), 'Committed via Ctrl+Enter.');
      expect(currencyRow.querySelector('.koi-gloss-input')).toBeNull();
    });

    test('Save trims leading/trailing whitespace before displaying the committed text', () => {
      const onSave = vi.fn();
      const { container } = render(<GlossaryPanel store={store()} handlers={{ ...noopHandlers, onSave }} />);
      const currencyRow = entryRow(container, 2); // undocumented enum
      fireEvent.click(within(currencyRow).getByRole('button', { name: 'Add description for Currency' }));
      const input = within(currencyRow).getByRole('textbox') as HTMLTextAreaElement;
      fireEvent.input(input, { target: { value: '  padded with whitespace  ' } });
      fireEvent.click(within(currencyRow).getByRole('button', { name: 'Save description for Currency' }));

      // The read view shows the trimmed text.
      expect(currencyRow.querySelector('.koi-gloss-doc')!.textContent).toBe('padded with whitespace');
    });

    // The slice does not re-render on a Save (the host reloads on a debounce), so `entry.doc` can still hold
    // the pre-save text when the user re-opens Edit and hits Cancel within that window. Cancel must revert to
    // what this row itself last committed (the useCommittableField internal ref), not the stale prop (#992
    // review) — otherwise it silently discards the just-completed Save.
    test('Cancel after a Save reverts to the just-saved value, not the stale entry.doc prop (#992 review)', () => {
      const onSave = vi.fn();
      const { container } = render(<GlossaryPanel store={store()} handlers={{ ...noopHandlers, onSave }} />);
      const moneyRow = entryRow(container, 1); // documented: doc = 'A monetary amount.'

      fireEvent.click(within(moneyRow).getByRole('button', { name: 'Edit description for Money' }));
      let input = within(moneyRow).getByRole('textbox') as HTMLTextAreaElement;
      fireEvent.input(input, { target: { value: 'A freshly saved amount.' } });
      fireEvent.click(within(moneyRow).getByRole('button', { name: 'Save description for Money' }));
      expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ name: 'Money' }), 'A freshly saved amount.');
      expect(moneyRow.querySelector('.koi-gloss-doc')!.textContent).toBe('A freshly saved amount.');

      // Re-open Edit on the same row (no remount — same stale entry.doc prop) and Cancel.
      fireEvent.click(within(moneyRow).getByRole('button', { name: 'Edit description for Money' }));
      input = within(moneyRow).getByRole('textbox') as HTMLTextAreaElement;
      expect(input.value).toBe('A freshly saved amount.'); // seeded from the just-saved value, not the prop
      fireEvent.click(within(moneyRow).getByRole('button', { name: 'Cancel editing description for Money' }));

      expect(moneyRow.querySelector('.koi-gloss-doc')!.textContent).toBe('A freshly saved amount.');
    });

    test('Escape after a Save reverts to the just-saved value, not the stale entry.doc prop (#992 review)', () => {
      const onSave = vi.fn();
      const { container } = render(<GlossaryPanel store={store()} handlers={{ ...noopHandlers, onSave }} />);
      const moneyRow = entryRow(container, 1);

      fireEvent.click(within(moneyRow).getByRole('button', { name: 'Edit description for Money' }));
      let input = within(moneyRow).getByRole('textbox') as HTMLTextAreaElement;
      fireEvent.input(input, { target: { value: 'A freshly saved amount.' } });
      fireEvent.click(within(moneyRow).getByRole('button', { name: 'Save description for Money' }));

      fireEvent.click(within(moneyRow).getByRole('button', { name: 'Edit description for Money' }));
      input = within(moneyRow).getByRole('textbox') as HTMLTextAreaElement;
      fireEvent.input(input, { target: { value: 'a discarded second draft' } });
      fireEvent.keyDown(input, { key: 'Escape' });

      expect(moneyRow.querySelector('.koi-gloss-doc')!.textContent).toBe('A freshly saved amount.');
    });
  });
});
