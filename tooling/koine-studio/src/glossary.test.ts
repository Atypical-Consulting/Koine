import { afterEach, describe, expect, test, vi } from 'vitest';
import { coverage, groupByContext, renderGlossary, type GlossaryHandlers } from '@/glossary';
import type { GlossaryEntry, GlossaryModel, Range } from '@/lsp';

afterEach(() => {
  document.body.innerHTML = '';
});

const range = (line: number): Range => ({ start: { line, character: 0 }, end: { line, character: 4 } });

function entry(partial: Partial<GlossaryEntry> & { name: string }): GlossaryEntry {
  const context = partial.context ?? 'Ordering';
  return {
    id: `${context}.${partial.name}`,
    kind: 'value',
    context,
    qualifiedName: `${context}.${partial.name}`,
    doc: null,
    nameRange: range(1),
    ...partial,
  };
}

const noopHandlers: GlossaryHandlers = { onGoto: () => {}, onSave: () => {} };

describe('coverage', () => {
  test('counts non-blank docs and rounds the percentage', () => {
    const entries = [
      entry({ name: 'Money', doc: 'An amount.' }),
      entry({ name: 'Currency', doc: null }),
      entry({ name: 'Email', doc: '   ' }), // blank → not documented
    ];
    expect(coverage(entries)).toEqual({ documented: 1, total: 3, pct: 33 });
  });

  test('an empty model is 0 / 0 at 0%', () => {
    expect(coverage([])).toEqual({ documented: 0, total: 0, pct: 0 });
  });
});

describe('groupByContext', () => {
  test('groups by context preserving first-seen order', () => {
    const groups = groupByContext([
      entry({ name: 'A', context: 'Ordering' }),
      entry({ name: 'B', context: 'Shipping' }),
      entry({ name: 'C', context: 'Ordering' }),
    ]);
    expect(groups.map((g) => g.context)).toEqual(['Ordering', 'Shipping']);
    expect(groups[0].entries.map((e) => e.name)).toEqual(['A', 'C']);
  });
});

describe('renderGlossary', () => {
  const model: GlossaryModel = {
    entries: [
      entry({ name: 'Ordering', kind: 'context', doc: 'The ordering context.' }),
      entry({ name: 'Money', kind: 'value', doc: 'A monetary amount.', nameRange: range(3) }),
      entry({ name: 'Currency', kind: 'enum', doc: null }),
    ],
  };

  test('renders a coverage gauge', () => {
    const el = renderGlossary(model, noopHandlers);
    expect(el.querySelector('.koi-gloss-coverage')!.textContent).toContain('2 / 3 documented · 67%');
    expect((el.querySelector('.koi-gloss-bar-fill') as HTMLElement).style.width).toBe('67%');
  });

  test('renders the context entry first, then types, each with its kind badge', () => {
    const el = renderGlossary(model, noopHandlers);
    const names = Array.from(el.querySelectorAll('.koi-gloss-name')).map((n) => n.textContent);
    expect(names).toEqual(['Ordering', 'Money', 'Currency']);
    const kinds = Array.from(el.querySelectorAll('.koi-gloss-kind')).map((n) => n.textContent);
    expect(kinds).toEqual(['context', 'value', 'enum']);
  });

  test('shows the doc for documented entries and a prompt for undocumented ones', () => {
    const el = renderGlossary(model, noopHandlers);
    const moneyRow = el.querySelectorAll('.koi-gloss-entry')[1]; // the documented value
    expect(moneyRow.querySelector('.koi-gloss-doc')!.textContent).toContain('A monetary amount.');
    expect(el.querySelector('.koi-gloss-needsdoc')!.textContent).toBe('Needs description');
  });

  test('clicking a name jumps to its source range', () => {
    const onGoto = vi.fn();
    const el = renderGlossary(model, { ...noopHandlers, onGoto });
    document.body.appendChild(el);
    el.querySelectorAll<HTMLButtonElement>('.koi-gloss-name')[1].click(); // Money → range(3)
    expect(onGoto).toHaveBeenCalledWith(range(3));
  });

  test('Add description opens an editor; Save persists the prose and closes', () => {
    const onSave = vi.fn();
    const el = renderGlossary(model, { ...noopHandlers, onSave });
    document.body.appendChild(el);

    const currencyRow = el.querySelectorAll('.koi-gloss-entry')[2]; // undocumented enum
    const addBtn = currencyRow.querySelector<HTMLButtonElement>('.koi-gloss-edit')!;
    expect(addBtn.textContent).toBe('Add description');
    addBtn.click();

    const input = currencyRow.querySelector<HTMLTextAreaElement>('.koi-gloss-input')!;
    input.value = 'The currency of an amount.';
    currencyRow.querySelector<HTMLButtonElement>('.koi-gloss-save')!.click();

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Currency' }),
      'The currency of an amount.',
    );
    expect(currencyRow.querySelector('.koi-gloss-input')).toBeNull(); // editor closed
    expect(currencyRow.querySelector('.koi-gloss-doc')!.textContent).toContain('The currency of an amount.');
  });

  test('Cancel discards the edit without calling onSave', () => {
    const onSave = vi.fn();
    const el = renderGlossary(model, { ...noopHandlers, onSave });
    document.body.appendChild(el);
    const row = el.querySelectorAll('.koi-gloss-entry')[2];
    row.querySelector<HTMLButtonElement>('.koi-gloss-edit')!.click();
    row.querySelector<HTMLTextAreaElement>('.koi-gloss-input')!.value = 'nope';
    row.querySelector<HTMLButtonElement>('.koi-gloss-cancel')!.click();
    expect(onSave).not.toHaveBeenCalled();
    expect(row.querySelector('.koi-gloss-input')).toBeNull();
  });
});
