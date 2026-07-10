import { describe, expect, test, vi } from 'vitest';
import { act, fireEvent, render, within } from '@testing-library/preact';
import { createAppStore } from '@/store/index';
import { GlossaryPanel } from '@/model/GlossaryPanel';
import type { GlossaryEntry, GlossaryModel, Range } from '@/lsp/lsp';
import type { GlossaryHandlers } from '@/model/glossary';
import { axe } from 'vitest-axe';

const range = (line = 0): Range => ({ start: { line, character: 0 }, end: { line, character: 4 } });

const entry = (name: string, context: string, kind = 'value'): GlossaryEntry => ({
  id: `${context}.${name}`,
  name,
  kind,
  context,
  qualifiedName: `${context}.${name}`,
  doc: null,
  nameRange: range(),
});

// A two-context glossary: Sales owns Order, Inv owns Stock. Scoping to "Sales" keeps Order, drops Stock.
const model: GlossaryModel = { entries: [entry('Order', 'Sales'), entry('Stock', 'Inv')] };

const noopHandlers: GlossaryHandlers = { onGoto: () => {}, onSave: () => {} };

describe('GlossaryPanel', () => {
  test('renders every context’s concepts when unscoped, narrows when the active context changes', () => {
    const store = createAppStore();
    const { container } = render(<GlossaryPanel store={store} model={model} handlers={noopHandlers} />);

    // Unscoped → both contexts' concepts present.
    expect(container.textContent).toContain('Order');
    expect(container.textContent).toContain('Stock');

    // Narrowing to Sales re-renders (act() flushes Preact's batched re-render) and drops the Inv concept.
    act(() => store.getState().setActiveContext('Sales'));
    expect(container.textContent).toContain('Order');
    expect(container.textContent).not.toContain('Stock');
  });

  test('scrolls the targeted term into view when a scroll target is given (#1165)', () => {
    const store = createAppStore();
    const scrolled: Element[] = [];
    const orig = Element.prototype.scrollIntoView;
    // happy-dom doesn't implement scrollIntoView; install a spy that records the element it lands on.
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
    try {
      render(
        <GlossaryPanel store={store} model={model} handlers={noopHandlers} scrollToTerm="Sales.Order" scrollNonce={1} />,
      );
      // The Order entry (data-qn="Sales.Order") is the one scrolled into view — not the whole panel.
      expect(scrolled.some((e) => e.getAttribute('data-qn') === 'Sales.Order')).toBe(true);
    } finally {
      Element.prototype.scrollIntoView = orig;
    }
  });

  test('has no accessibility violations', async () => {
    const store = createAppStore();
    const { container } = render(<GlossaryPanel store={store} model={model} handlers={noopHandlers} />);
    expect(await axe(container)).toHaveNoViolations();
  });

  // The coverage gauge, declaration ordering, and the inline description editor (Edit/Save/Cancel/Escape/
  // Cmd-Enter) — pinned here (formerly asserted against the `renderGlossary` DOM builder directly in
  // glossary.test.ts) now that the panel owns the markup as real JSX (#992).
  describe('coverage gauge, ordering, and the inline description editor', () => {
    const editorModel: GlossaryModel = {
      entries: [
        entry('Ordering', 'Ordering', 'context'),
        entry('Money', 'Ordering', 'value'),
        entry('Currency', 'Ordering', 'enum'),
      ],
    };
    // Seed docs directly (the `entry` fixture above defaults doc to null).
    editorModel.entries[0].doc = 'The ordering context.';
    editorModel.entries[1].doc = 'A monetary amount.';
    editorModel.entries[1].nameRange = range(3);

    const entryRow = (container: Element, index: number) =>
      container.querySelectorAll<HTMLElement>('.koi-gloss-entry')[index];

    test('renders a coverage gauge with the documented count and bar width', () => {
      const store = createAppStore();
      const { container } = render(<GlossaryPanel store={store} model={editorModel} handlers={noopHandlers} />);
      expect(container.querySelector('.koi-gloss-coverage')!.textContent).toContain('2 / 3 documented · 67%');
      expect((container.querySelector('.koi-gloss-bar-fill') as HTMLElement).style.width).toBe('67%');
    });

    test('renders the context entry first, then its types, each with its kind badge', () => {
      const store = createAppStore();
      const { container } = render(<GlossaryPanel store={store} model={editorModel} handlers={noopHandlers} />);
      const names = Array.from(container.querySelectorAll('.koi-gloss-name')).map((n) => n.textContent);
      expect(names).toEqual(['Ordering', 'Money', 'Currency']);
      const kinds = Array.from(container.querySelectorAll('.koi-gloss-kind')).map((n) => n.textContent);
      expect(kinds).toEqual(['context', 'value', 'enum']);
    });

    test('each entry carries its qualified-name anchor (data-qn) for scroll-to-term (#1165)', () => {
      const store = createAppStore();
      const { container } = render(<GlossaryPanel store={store} model={editorModel} handlers={noopHandlers} />);
      const anchors = Array.from(container.querySelectorAll('.koi-gloss-entry')).map((e) => e.getAttribute('data-qn'));
      expect(anchors).toEqual(['Ordering.Ordering', 'Ordering.Money', 'Ordering.Currency']);
    });

    test('shows the doc for documented entries and a prompt for undocumented ones', () => {
      const store = createAppStore();
      const { container } = render(<GlossaryPanel store={store} model={editorModel} handlers={noopHandlers} />);
      const moneyRow = entryRow(container, 1);
      expect(moneyRow.querySelector('.koi-gloss-doc')!.textContent).toContain('A monetary amount.');
      expect(container.querySelector('.koi-gloss-needsdoc')!.textContent).toBe('Needs description');
    });

    test('clicking a name jumps to its source range', () => {
      const onGoto = vi.fn();
      const store = createAppStore();
      const { container } = render(
        <GlossaryPanel store={store} model={editorModel} handlers={{ ...noopHandlers, onGoto }} />,
      );
      fireEvent.click(entryRow(container, 1).querySelector<HTMLButtonElement>('.koi-gloss-name')!); // Money
      expect(onGoto).toHaveBeenCalledWith(range(3));
    });

    test('Edit opens a focused textarea seeded with the current description', () => {
      const store = createAppStore();
      const { container } = render(<GlossaryPanel store={store} model={editorModel} handlers={noopHandlers} />);
      const moneyRow = entryRow(container, 1);
      fireEvent.click(within(moneyRow).getByRole('button', { name: 'Edit description for Money' }));

      const textarea = within(moneyRow).getByRole('textbox') as HTMLTextAreaElement;
      expect(textarea.value).toBe('A monetary amount.');
      expect(document.activeElement).toBe(textarea);
    });

    test('Save calls onSave and closes back to the read view with the new text', () => {
      const onSave = vi.fn();
      const store = createAppStore();
      const { container } = render(
        <GlossaryPanel store={store} model={editorModel} handlers={{ ...noopHandlers, onSave }} />,
      );
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
      const store = createAppStore();
      const { container } = render(
        <GlossaryPanel store={store} model={editorModel} handlers={{ ...noopHandlers, onSave }} />,
      );
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
      const store = createAppStore();
      const { container } = render(
        <GlossaryPanel store={store} model={editorModel} handlers={{ ...noopHandlers, onSave }} />,
      );
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
      const store = createAppStore();
      const { container } = render(
        <GlossaryPanel store={store} model={editorModel} handlers={{ ...noopHandlers, onSave }} />,
      );
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
      const store = createAppStore();
      const { container } = render(
        <GlossaryPanel store={store} model={editorModel} handlers={{ ...noopHandlers, onSave }} />,
      );
      const currencyRow = entryRow(container, 2); // undocumented enum
      fireEvent.click(within(currencyRow).getByRole('button', { name: 'Add description for Currency' }));
      const input = within(currencyRow).getByRole('textbox') as HTMLTextAreaElement;
      fireEvent.input(input, { target: { value: '  padded with whitespace  ' } });
      fireEvent.click(within(currencyRow).getByRole('button', { name: 'Save description for Currency' }));

      // The read view shows the trimmed text (matching the old renderDescription's `.trim() || null`).
      expect(currencyRow.querySelector('.koi-gloss-doc')!.textContent).toBe('padded with whitespace');
    });

    // Regression test for the review finding: GlossaryPanel is only remounted on a debounced (350ms)
    // onDocEdited reload, tab-open, or scroll-to-term — never as an in-place props update right after
    // Save. So `entry.doc` (the prop) can still hold the pre-save text when the user re-opens Edit and
    // hits Cancel within that window. Cancel must revert to what this row itself last committed, not to
    // the (stale) prop — otherwise it silently discards the just-completed Save.
    test('Cancel after a Save reverts to the just-saved value, not the stale entry.doc prop (#992 review)', () => {
      const onSave = vi.fn();
      const store = createAppStore();
      const { container } = render(
        <GlossaryPanel store={store} model={editorModel} handlers={{ ...noopHandlers, onSave }} />,
      );
      const moneyRow = entryRow(container, 1); // documented: entry.doc = 'A monetary amount.'

      // Save a new description. The `entry.doc` prop is untouched (no remount) — only the row's own
      // `draft` state reflects the new text, simulating the real debounce/LSP-round-trip window.
      fireEvent.click(within(moneyRow).getByRole('button', { name: 'Edit description for Money' }));
      let input = within(moneyRow).getByRole('textbox') as HTMLTextAreaElement;
      fireEvent.input(input, { target: { value: 'A freshly saved amount.' } });
      fireEvent.click(within(moneyRow).getByRole('button', { name: 'Save description for Money' }));
      expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ name: 'Money' }), 'A freshly saved amount.');
      expect(moneyRow.querySelector('.koi-gloss-doc')!.textContent).toBe('A freshly saved amount.');

      // Re-open Edit on the same row (still no remount — same stale entry.doc prop) and Cancel.
      fireEvent.click(within(moneyRow).getByRole('button', { name: 'Edit description for Money' }));
      input = within(moneyRow).getByRole('textbox') as HTMLTextAreaElement;
      expect(input.value).toBe('A freshly saved amount.'); // seeded from the just-saved value, not the prop
      fireEvent.click(within(moneyRow).getByRole('button', { name: 'Cancel editing description for Money' }));

      // Must still show the just-saved text — NOT revert to the stale prop ('A monetary amount.').
      expect(moneyRow.querySelector('.koi-gloss-doc')!.textContent).toBe('A freshly saved amount.');
    });

    test('Escape after a Save reverts to the just-saved value, not the stale entry.doc prop (#992 review)', () => {
      const onSave = vi.fn();
      const store = createAppStore();
      const { container } = render(
        <GlossaryPanel store={store} model={editorModel} handlers={{ ...noopHandlers, onSave }} />,
      );
      const moneyRow = entryRow(container, 1); // documented: entry.doc = 'A monetary amount.'

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
