import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderStrategic } from '@/model/domainNavigator';
import type { GlossaryEntry, GlossaryModel, Range } from '@/lsp/lsp';

afterEach(() => {
  document.body.innerHTML = '';
});

const range = (line: number): Range => ({ start: { line, character: 2 }, end: { line, character: 8 } });

function entry(partial: Partial<GlossaryEntry> & { name: string; kind: string; context: string }): GlossaryEntry {
  return {
    id: `${partial.context}.${partial.name}`,
    qualifiedName: `${partial.context}.${partial.name}`,
    doc: null,
    nameRange: range(1),
    ...partial,
  };
}

// One context header + exactly seven non-context construct entries per context, spread across kinds
// so the per-context total tally is 7 (Aggregates 1, Entities 1, Value Objects 2, Enumerations 1,
// Domain Events 1, Types 1) — matching the expected '7' badge for 'Ordering'.
function fakeGlossary(contexts: string[]): GlossaryModel {
  const entries: GlossaryEntry[] = [];
  for (const ctx of contexts) {
    entries.push(entry({ name: ctx, kind: 'context', context: ctx, nameRange: range(0) }));
    entries.push(entry({ name: `${ctx}Order`, kind: 'aggregate', context: ctx }));
    entries.push(entry({ name: `${ctx}Line`, kind: 'entity', context: ctx }));
    entries.push(entry({ name: `${ctx}Money`, kind: 'value', context: ctx }));
    entries.push(entry({ name: `${ctx}Weight`, kind: 'quantity', context: ctx }));
    entries.push(entry({ name: `${ctx}Status`, kind: 'enum', context: ctx }));
    entries.push(entry({ name: `${ctx}Placed`, kind: 'event', context: ctx }));
    entries.push(entry({ name: `${ctx}Ref`, kind: 'type', context: ctx }));
  }
  return { entries };
}

describe('renderStrategic', () => {
  it('renders ◈ context rows with total-count badges and a context-map link count', () => {
    const onOpenContext = vi.fn();
    const el = renderStrategic(fakeGlossary(['Ordering', 'Billing']), 4,
      { onOpenContext, onOpenContextMap: vi.fn(), onOpenGlossary: vi.fn() });
    expect([...el.querySelectorAll('.koi-ctx-row')].length).toBe(2);
    expect(el.querySelector('[data-ctx="Ordering"] .koi-ctx-count')!.textContent).toBe('7');
    expect(el.textContent).toContain('Context Map');
    expect(el.textContent).toContain('4');
    (el.querySelector('[data-ctx="Ordering"]') as HTMLButtonElement).click();
    expect(onOpenContext).toHaveBeenCalledWith('Ordering');
  });
});
