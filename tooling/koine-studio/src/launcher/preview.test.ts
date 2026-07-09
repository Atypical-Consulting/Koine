// Live PREVIEW pane data builders (issue #1143, task 5): 8 pure functions that map REAL model/git data
// to a `PreviewViewModel` — no innerHTML, no DOM, no fabricated prototype demo strings. Ported from the
// 8 `*Preview` builders in design/design_handoff_git_spotlight_logos/koine-launcher.js, but retargeted
// at the real typed seams (`ModelElement`, `GlossaryEntry`, `GitLogEntry`) instead of hand-authored data.
import { describe, expect, test } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ModelElement } from '@/model/modelIndex';
import type { GlossaryEntry, ModelMember } from '@/lsp/lsp';
import type { GitLogEntry } from '@/host/types';
import type { CatalogEntry } from '@/launcher/catalog';
import {
  actionPreview,
  commitPreview,
  eventPreview,
  filePreview,
  glossPreview,
  previewFor,
  rulePreview,
  symbolPreview,
  transitionPreview,
} from '@/launcher/preview';

const RANGE = { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } };

function glossaryEntry(overrides: Partial<GlossaryEntry> & Pick<GlossaryEntry, 'name' | 'kind' | 'context' | 'qualifiedName'>): GlossaryEntry {
  return { id: overrides.qualifiedName, doc: null, nameRange: RANGE, ...overrides };
}

function field(name: string, type: string, value: string | null = null): ModelMember {
  return { kind: 'field', name, type, value };
}

describe('symbolPreview', () => {
  const entry = glossaryEntry({
    name: 'OrderLine', kind: 'value', context: 'Ordering', qualifiedName: 'Ordering.OrderLine',
    doc: 'One line item on an order.',
  });
  const element: ModelElement = {
    entry,
    node: {
      id: 'n1', label: 'OrderLine', kind: 'value-object', qualifiedName: 'Ordering.OrderLine',
      sourceSpan: { file: 'file:///ws/src/domain/ordering.koi', line: 5, column: 1, endLine: 9, endColumn: 2, offset: 0, length: 0 },
      stereotype: 'value object', members: [],
      invariants: ['quantity must be positive'],
    },
    modelMembers: [field('quantity', 'Int'), field('unitPrice', 'Money')],
  };

  test('yields a header with the DDD chip slug, a code block from real members, and a meta grid', () => {
    const vm = symbolPreview(element);
    expect(vm.header).toEqual({ chipSlug: 'value', name: 'OrderLine', sub: 'value object · Ordering' });
    expect(vm.codeLines).toEqual(['value OrderLine {', '  quantity: Int', '  unitPrice: Money', '}']);
    expect(vm.meta).toContainEqual(['Kind', 'value object']);
    expect(vm.meta).toContainEqual(['Context', 'Ordering']);
    expect(vm.meta).toContainEqual(['Members', '2 fields']);
    expect(vm.meta).toContainEqual(['Invariants', '1']);
    expect(vm.filePath).toBe('ordering.koi · line 5');
    expect(vm.note).toBe('One line item on an order.');
  });

  test('omits the code block entirely when there are no members', () => {
    const bare: ModelElement = { entry: glossaryEntry({ name: 'OrderId', kind: 'value', context: 'Ordering', qualifiedName: 'Ordering.OrderId' }) };
    const vm = symbolPreview(bare);
    expect(vm.codeLines).toBeUndefined();
    expect(vm.filePath).toBeUndefined();
  });

  test('normalizes the raw glossary "quantity" kind to the "value" chip, same as the catalog builder', () => {
    const quantity: ModelElement = { entry: glossaryEntry({ name: 'Money', kind: 'quantity', context: 'Shared', qualifiedName: 'Shared.Money' }) };
    const vm = symbolPreview(quantity);
    expect(vm.header.chipSlug).toBe('value');
  });

  test('renders an enum\'s members as its state list', () => {
    const statusEntry = glossaryEntry({ name: 'OrderStatus', kind: 'enum', context: 'Ordering', qualifiedName: 'Ordering.OrderStatus' });
    const enumEl: ModelElement = {
      entry: statusEntry,
      modelMembers: [
        { kind: 'enumMember', name: 'Draft', type: null, value: null },
        { kind: 'enumMember', name: 'Placed', type: null, value: null },
      ],
    };
    const vm = symbolPreview(enumEl);
    expect(vm.states).toEqual(['Draft', 'Placed']);
  });
});

describe('eventPreview', () => {
  test('yields payloadFields from the members', () => {
    const entry = glossaryEntry({ name: 'OrderPlaced', kind: 'event', context: 'Ordering', qualifiedName: 'Ordering.OrderPlaced' });
    const element: ModelElement = { entry, modelMembers: [field('orderId', 'OrderId'), field('total', 'Money')] };

    const vm = eventPreview(element);

    expect(vm.header.chipSlug).toBe('event');
    expect(vm.payloadFields).toEqual([['orderId', 'OrderId'], ['total', 'Money']]);
  });

  test('omits payloadFields when the event has no members, and normalizes "integration event" to the IE chip', () => {
    const entry = glossaryEntry({ name: 'PaymentCaptured', kind: 'integration event', context: 'Billing', qualifiedName: 'Billing.PaymentCaptured' });
    const vm = eventPreview({ entry });
    expect(vm.payloadFields).toBeUndefined();
    expect(vm.header.chipSlug).toBe('integration-event');
  });
});

describe('actionPreview', () => {
  test('renders the command title/sub and a shortcut meta row when a hint is given', () => {
    const vm = actionPreview({ title: 'Generate', sub: 'Compile the model → C#', hint: '⌘↵' });
    expect(vm.header).toEqual({ glyph: 'action', name: 'Generate', sub: 'Compile the model → C#' });
    expect(vm.meta).toContainEqual(['Shortcut', '⌘↵']);
  });

  test('omits the shortcut row when there is no hint', () => {
    const vm = actionPreview({ title: 'Open Settings' });
    expect(vm.meta).toBeUndefined();
  });
});

describe('filePreview', () => {
  test('splits the basename from the directory and carries the file path', () => {
    const vm = filePreview({ relPath: 'src/domain/ordering.koi' });
    expect(vm.header).toEqual({ glyph: 'file', name: 'ordering.koi', sub: 'src/domain' });
    expect(vm.filePath).toBe('src/domain/ordering.koi');
    expect(vm.diff).toBeUndefined();
    expect(vm.note).toBe('Open the file to view its contents.');
  });

  test('renders a supplied diff and drops the no-diff note', () => {
    const vm = filePreview({ relPath: 'koine.config.json', diff: [{ sign: '+', text: 'added line' }] });
    expect(vm.diff).toEqual([{ sign: '+', text: 'added line' }]);
    expect(vm.note).toBeUndefined();
  });
});

describe('glossPreview', () => {
  test('yields the definition text as the description', () => {
    const entry = glossaryEntry({
      name: 'Aggregate', kind: 'context', context: 'Ubiquitous language', qualifiedName: 'Aggregate',
      doc: 'A cluster of domain objects treated as one consistency boundary.',
    });
    const vm = glossPreview(entry);
    expect(vm.header).toEqual({ glyph: 'gloss', name: 'Aggregate', sub: 'ubiquitous language' });
    expect(vm.desc).toBe('A cluster of domain objects treated as one consistency boundary.');
    expect(vm.note).toBeUndefined();
    // Not derivable from a bare GlossaryEntry — no reverse-reference source exists yet (documented gap).
    expect(vm.glossaryPills).toBeUndefined();
  });

  test('falls back to a documentation note when the term has no /// doc', () => {
    const entry = glossaryEntry({ name: 'Invariant', kind: 'context', context: 'Ubiquitous language', qualifiedName: 'Invariant' });
    const vm = glossPreview(entry);
    expect(vm.desc).toBeUndefined();
    expect(vm.note).toBe('No documentation yet — add a /// comment to define this term.');
  });
});

describe('rulePreview', () => {
  test('yields rule.expr from the invariant text', () => {
    const vm = rulePreview({ expr: 'quantity > 0', owner: 'OrderLine', ctx: 'Ordering' });
    expect(vm.rule).toEqual({ kind: 'invariant', expr: 'quantity > 0' });
    expect(vm.rule?.message).toBeUndefined();
    expect(vm.meta).toContainEqual(['Enforced on', 'OrderLine']);
  });
});

describe('transitionPreview', () => {
  test('yields { from, to }', () => {
    const vm = transitionPreview({ from: 'Draft', to: 'Placed', owner: 'Order' });
    expect(vm.transition).toEqual({ from: 'Draft', to: 'Placed' });
    expect(vm.header.name).toBe('Draft → Placed');
  });

  test('surfaces a real edge\'s guard + trigger in the transition and meta', () => {
    const vm = transitionPreview({ from: 'Draft', to: 'Submitted', guard: 'totalIsPositive', via: 'Submit', owner: 'Order' });
    expect(vm.transition).toEqual({ from: 'Draft', to: 'Submitted', guard: 'totalIsPositive', via: 'Submit' });
    expect(vm.header.name).toBe('Draft → Submitted');
    expect(vm.meta).toContainEqual(['Owner', 'Order']);
    expect(vm.meta).toContainEqual(['Guard', 'totalIsPositive']);
    expect(vm.meta).toContainEqual(['Via', 'Submit']);
  });
});

describe('commitPreview', () => {
  test('yields the commit meta and a short hash', () => {
    const commit: GitLogEntry = { sha: 'abc1234567890', author: 'Ada Lovelace', date: '2026-07-01T10:00:00Z', message: 'feat: add shipping event' };
    const vm = commitPreview(commit);
    expect(vm.header).toEqual({ glyph: 'commit', name: 'feat: add shipping event', sub: 'commit' });
    expect(vm.meta).toContainEqual(['Commit', 'abc1234']);
    expect(vm.meta).toContainEqual(['Author', 'Ada Lovelace']);
    expect(vm.meta).toContainEqual(['When', '2026-07-01']);
    // Not derivable from GitLogEntry alone — the git log summary carries no per-commit file list.
    expect(vm.commitFiles).toBeUndefined();
    expect(vm.note).toBeTruthy();
  });
});

describe('previewFor — dispatch', () => {
  const orderLineEntry = glossaryEntry({ name: 'OrderLine', kind: 'value', context: 'Ordering', qualifiedName: 'Ordering.OrderLine' });
  const orderLineElement: ModelElement = { entry: orderLineEntry, modelMembers: [field('quantity', 'Int')] };

  test('symbol: uses ctx.element when present', () => {
    const entry: CatalogEntry = { id: 'sym:1', cat: 'symbol', kind: 'value', title: 'OrderLine', qualifiedName: 'Ordering.OrderLine' };
    const vm = previewFor(entry, { element: orderLineElement });
    expect(vm?.header.name).toBe('OrderLine');
  });

  test('symbol: returns null when there is no element to preview', () => {
    const entry: CatalogEntry = { id: 'sym:2', cat: 'symbol', kind: 'value', title: 'Unresolved' };
    expect(previewFor(entry, {})).toBeNull();
  });

  test('event: dispatches to eventPreview', () => {
    const eventEntry: CatalogEntry = { id: 'evt:1', cat: 'event', kind: 'event', title: 'OrderPlaced', qualifiedName: 'Ordering.OrderPlaced' };
    const eventElement: ModelElement = { entry: glossaryEntry({ name: 'OrderPlaced', kind: 'event', context: 'Ordering', qualifiedName: 'Ordering.OrderPlaced' }), modelMembers: [field('orderId', 'OrderId')] };
    const vm = previewFor(eventEntry, { element: eventElement });
    expect(vm?.payloadFields).toEqual([['orderId', 'OrderId']]);
  });

  test('action: builds directly from the entry\'s own title/sub/hint, no ctx needed', () => {
    const entry: CatalogEntry = { id: 'cmd:1', cat: 'action', title: 'Generate', sub: 'Compile', hint: '⌘↵' };
    const vm = previewFor(entry, {});
    expect(vm?.header.name).toBe('Generate');
    expect(vm?.meta).toContainEqual(['Shortcut', '⌘↵']);
  });

  test('file: reconstructs the relative path from sub + title when no ctx.file is given', () => {
    const entry: CatalogEntry = { id: 'file:1', cat: 'file', title: 'ordering.koi', sub: 'src/domain', file: 'file:///ws/src/domain/ordering.koi' };
    const vm = previewFor(entry, {});
    expect(vm?.filePath).toBe('src/domain/ordering.koi');
  });

  test('file: returns null when the entry carries no file identity at all', () => {
    const entry: CatalogEntry = { id: 'file:2', cat: 'file', title: 'orphan.koi' };
    expect(previewFor(entry, {})).toBeNull();
  });

  test('glossary: dispatches to glossPreview via ctx.glossary', () => {
    const entry: CatalogEntry = { id: 'gloss:1', cat: 'glossary', title: 'Aggregate', qualifiedName: 'Aggregate' };
    const glossary = glossaryEntry({ name: 'Aggregate', kind: 'context', context: 'Ubiquitous language', qualifiedName: 'Aggregate', doc: 'A cluster.' });
    const vm = previewFor(entry, { glossary });
    expect(vm?.desc).toBe('A cluster.');
  });

  test('rule (rkind "rule"): dispatches to rulePreview using the resolved owner element', () => {
    const entry: CatalogEntry = { id: 'rule:1', cat: 'rule', rkind: 'rule', title: 'quantity > 0', qualifiedName: 'Ordering.OrderLine' };
    const vm = previewFor(entry, { element: orderLineElement });
    expect(vm?.rule).toEqual({ kind: 'invariant', expr: 'quantity > 0' });
  });

  test('rule (rkind "state"): yields the enum\'s declared state list, NEVER a fabricated transition (#1145)', () => {
    // Guarded transitions aren't indexed, so a state entry must not invent an "A → B" edge from
    // declaration adjacency — it shows the honest flat state list instead.
    const statusEntry = glossaryEntry({ name: 'OrderStatus', kind: 'enum', context: 'Ordering', qualifiedName: 'Ordering.OrderStatus' });
    const statusElement: ModelElement = {
      entry: statusEntry,
      modelMembers: [
        { kind: 'enumMember', name: 'Draft', type: null, value: null },
        { kind: 'enumMember', name: 'Placed', type: null, value: null },
        { kind: 'enumMember', name: 'Shipped', type: null, value: null },
      ],
    };
    const entry: CatalogEntry = { id: 'rule:2', cat: 'rule', rkind: 'state', title: 'Placed', qualifiedName: 'Ordering.OrderStatus' };

    const vm = previewFor(entry, { element: statusElement });

    expect(vm?.transition).toBeUndefined();
    expect(vm?.states).toEqual(['Draft', 'Placed', 'Shipped']);
    expect(vm?.header).toEqual({ chipSlug: 'enum', name: 'Placed', sub: 'state · OrderStatus' });
    expect(vm?.note).toBeTruthy();
  });

  test('rule (rkind "state"): still yields the bare state list for a single-state enum', () => {
    const statusEntry = glossaryEntry({ name: 'OrderStatus', kind: 'enum', context: 'Ordering', qualifiedName: 'Ordering.OrderStatus' });
    const statusElement: ModelElement = { entry: statusEntry, modelMembers: [{ kind: 'enumMember', name: 'OnlyState', type: null, value: null }] };
    const entry: CatalogEntry = { id: 'rule:3', cat: 'rule', rkind: 'state', title: 'OnlyState', qualifiedName: 'Ordering.OrderStatus' };

    const vm = previewFor(entry, { element: statusElement });

    expect(vm?.transition).toBeUndefined();
    expect(vm?.states).toEqual(['OnlyState']);
    expect(vm?.note).toBeTruthy();
  });

  test('rule (rkind "transition"): dispatches to transitionPreview off the carried edge, not rulePreview', () => {
    const orderEntry = glossaryEntry({ name: 'Order', kind: 'aggregate', context: 'Ordering', qualifiedName: 'Ordering.Order' });
    const orderElement: ModelElement = { entry: orderEntry };
    const entry: CatalogEntry = {
      id: 'rule:Ordering.Order:trans:Draft->Submitted', cat: 'rule', rkind: 'transition', title: 'Draft → Submitted',
      qualifiedName: 'Ordering.Order', transition: { from: 'Draft', to: 'Submitted', guard: 'totalIsPositive', via: 'Submit' },
    };

    const vm = previewFor(entry, { element: orderElement });

    expect(vm?.transition).toEqual({ from: 'Draft', to: 'Submitted', guard: 'totalIsPositive', via: 'Submit' });
    expect(vm?.header.name).toBe('Draft → Submitted');
    expect(vm?.meta).toContainEqual(['Owner', 'Order']);
    expect(vm?.meta).toContainEqual(['Guard', 'totalIsPositive']);
    expect(vm?.meta).toContainEqual(['Via', 'Submit']);
    // NOT a rulePreview: the invariant-shaped rule block must not be produced for a transition.
    expect(vm?.rule).toBeUndefined();
  });

  test('commit: dispatches to commitPreview via ctx.commit', () => {
    const entry: CatalogEntry = { id: 'commit:abc', cat: 'commit', title: 'fix: bug', hash: 'abc1234567890', date: '2026-07-01T10:00:00Z' };
    const commit: GitLogEntry = { sha: 'abc1234567890', author: 'Ada Lovelace', date: '2026-07-01T10:00:00Z', message: 'fix: bug' };
    const vm = previewFor(entry, { commit });
    expect(vm?.meta).toContainEqual(['Commit', 'abc1234']);
  });

  test('returns null for a category with no previewable data at all', () => {
    const entry: CatalogEntry = { id: 'commit:none', cat: 'commit', title: 'no commit context' };
    expect(previewFor(entry, {})).toBeNull();
  });
});

describe('preview.ts — module import discipline', () => {
  test('imports only types from the lsp/host/model client modules — value-imports stay inside @/launcher/', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'preview.ts'), 'utf8');
    const importLines = src.split('\n').filter((l) => /^import /.test(l) && !/from ['"]@\/launcher\//.test(l));
    for (const line of importLines) {
      expect(line).toMatch(/^import type /);
    }
  });

  test('every .ts file under src/launcher only ever value-imports from other launcher modules, the pure dddKind fold, or vitest', () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    const files = readdirSync(dir).filter((f) => /\.ts$/.test(f) && !/\.test\.ts$/.test(f));
    // The canonical, pure, DOM-free `@/model/dddKind` alias fold (issue #1162) is a sanctioned VALUE
    // import from outside `@/launcher/` — it carries no DOM/LSP/host dependency, unlike the other
    // model/lsp/host seams this guard otherwise restricts to type-only imports.
    for (const file of files) {
      const full = join(dir, file);
      if (statSync(full).isDirectory()) continue;
      const src = readFileSync(full, 'utf8');
      const valueImports = src.split('\n').filter((l) => /^import (?!type )/.test(l));
      for (const line of valueImports) {
        expect(/from ['"]@\/launcher\//.test(line) || /from ['"]@\/model\/dddKind['"]/.test(line)).toBe(true);
      }
    }
  });
});
