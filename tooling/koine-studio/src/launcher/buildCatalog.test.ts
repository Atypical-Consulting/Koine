import { describe, expect, test } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Command } from '@atypical/koine-ui';
import type { ModelIndex } from '@/model/modelIndex';
import type { GlossaryEntry } from '@/lsp/lsp';
import type { GitLogEntry } from '@/host/types';
import { buildCatalog, type LauncherSources } from '@/launcher/buildCatalog';

// Hand-built fixtures standing in for the real model index / git store / command registry — the
// whole point of `LauncherSources` is that buildCatalog never has to know these are fakes.
const RANGE = { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } };

function glossaryEntry(overrides: Partial<GlossaryEntry> & Pick<GlossaryEntry, 'name' | 'kind' | 'context' | 'qualifiedName'>): GlossaryEntry {
  return { id: overrides.qualifiedName, doc: null, nameRange: RANGE, ...overrides };
}

const orderAgg = glossaryEntry({ name: 'Order', kind: 'aggregate', context: 'Ordering', qualifiedName: 'Ordering.Order', doc: 'The order aggregate root.' });
// The backend's GlossaryModelBuilder emits "quantity" (not "value") for a `quantity` value object —
// buildCatalog must normalize it the same way src/model/inspector.ts's constructKey() does.
const moneyVo = glossaryEntry({ name: 'Money', kind: 'quantity', context: 'Ordering', qualifiedName: 'Ordering.Money' });
const statusEnum = glossaryEntry({ name: 'OrderStatus', kind: 'enum', context: 'Ordering', qualifiedName: 'Ordering.OrderStatus' });
const placedEvent = glossaryEntry({ name: 'OrderPlaced', kind: 'event', context: 'Ordering', qualifiedName: 'Ordering.OrderPlaced' });
const shippedIntegrationEvent = glossaryEntry({ name: 'OrderShipped', kind: 'integration-event', context: 'Ordering', qualifiedName: 'Ordering.OrderShipped' });
// The backend's real spelling is "integration event" (a SPACE) — a second fixture proving that
// spelling normalizes too, not just the already-hyphenated one above.
const cancelledIntegrationEvent = glossaryEntry({ name: 'OrderCancelled', kind: 'integration event', context: 'Ordering', qualifiedName: 'Ordering.OrderCancelled' });

const modelIndex: ModelIndex = {
  glossary: { entries: [orderAgg, moneyVo, statusEnum, placedEvent, shippedIntegrationEvent, cancelledIntegrationEvent] },
  byQn: new Map([
    [orderAgg.qualifiedName, {
      entry: orderAgg,
      node: {
        id: 'n1', label: 'Order', kind: 'aggregate-root', qualifiedName: orderAgg.qualifiedName,
        sourceSpan: null, stereotype: 'aggregate root', members: [],
        invariants: ['total must be non-negative', 'at least one line item'],
      },
    }],
    [moneyVo.qualifiedName, { entry: moneyVo }],
    [statusEnum.qualifiedName, {
      entry: statusEnum,
      modelMembers: [
        { kind: 'enumMember', name: 'Draft', type: null, value: null },
        { kind: 'enumMember', name: 'Placed', type: null, value: null },
      ],
    }],
    [placedEvent.qualifiedName, { entry: placedEvent }],
    [shippedIntegrationEvent.qualifiedName, { entry: shippedIntegrationEvent }],
    [cancelledIntegrationEvent.qualifiedName, { entry: cancelledIntegrationEvent }],
  ]),
  qnByCtxName: new Map(),
};

const commands: Command[] = [
  { id: 'palette.newModel', title: 'New model', group: 'File', hint: '⌘N', run: () => {} },
  { id: 'palette.format', title: 'Format document', group: 'Editor', run: () => {} },
];

const files = [
  { uri: 'file:///ws/src/Ordering/Order.koi', relPath: 'src/Ordering/Order.koi' },
  { uri: 'file:///ws/README.md', relPath: 'README.md' },
];

const glossaryTerms: GlossaryEntry[] = [orderAgg, moneyVo];

const gitLogEntries: GitLogEntry[] = [
  { sha: 'abc1234567890', author: 'Ada Lovelace', date: '2026-07-01T10:00:00Z', message: 'feat: add shipping event' },
  { sha: 'def0987654321', author: 'Alan Turing', date: '2026-06-30T09:00:00Z', message: 'fix: rounding bug' },
];

const sourcesWithGit: LauncherSources = {
  modelIndex: () => Promise.resolve(modelIndex),
  commands: () => commands,
  files: () => files,
  gitLog: () => Promise.resolve(gitLogEntries),
  canUseGit: true,
  glossary: () => glossaryTerms,
};

const sourcesNoGit: LauncherSources = {
  ...sourcesWithGit,
  gitLog: () => null,
  canUseGit: false,
};

describe('buildCatalog — symbols', () => {
  test('maps aggregate/value/enum glossary entries to symbol entries carrying the DDD chip kind + qualifiedName', async () => {
    const symbols = (await buildCatalog(sourcesWithGit)).filter((e) => e.cat === 'symbol');
    const order = symbols.find((e) => e.qualifiedName === 'Ordering.Order');
    expect(order).toMatchObject({
      id: 'sym:Ordering.Order', cat: 'symbol', kind: 'aggregate', title: 'Order', ctx: 'Ordering',
      qualifiedName: 'Ordering.Order', nameRange: RANGE, sub: 'aggregate root',
    });
    expect(order?.keywords).toContain('order');
    expect(order?.keywords).toContain('ordering');
  });

  test('normalizes the backend\'s "quantity" kind to the "value" chip', async () => {
    const symbols = (await buildCatalog(sourcesWithGit)).filter((e) => e.cat === 'symbol');
    const money = symbols.find((e) => e.qualifiedName === 'Ordering.Money');
    expect(money).toMatchObject({ kind: 'value', sub: 'value object', title: 'Money' });
  });

  test('lists an enum as a symbol too', async () => {
    const symbols = (await buildCatalog(sourcesWithGit)).filter((e) => e.cat === 'symbol');
    const status = symbols.find((e) => e.qualifiedName === 'Ordering.OrderStatus');
    expect(status).toMatchObject({ kind: 'enum', sub: 'enum' });
  });
});

describe('buildCatalog — events', () => {
  test('maps both event and integration-event entries to the event category', async () => {
    const events = (await buildCatalog(sourcesWithGit)).filter((e) => e.cat === 'event');
    expect(events.map((e) => e.qualifiedName).sort()).toEqual([
      'Ordering.OrderCancelled', 'Ordering.OrderPlaced', 'Ordering.OrderShipped',
    ]);
    const placed = events.find((e) => e.qualifiedName === 'Ordering.OrderPlaced');
    expect(placed).toMatchObject({ kind: 'event', sub: 'domain event' });
    const shipped = events.find((e) => e.qualifiedName === 'Ordering.OrderShipped');
    expect(shipped).toMatchObject({ kind: 'integration-event', sub: 'integration event' });
  });

  test('normalizes the backend\'s "integration event" (space) spelling too', async () => {
    const events = (await buildCatalog(sourcesWithGit)).filter((e) => e.cat === 'event');
    const cancelled = events.find((e) => e.qualifiedName === 'Ordering.OrderCancelled');
    expect(cancelled).toMatchObject({ kind: 'integration-event', sub: 'integration event' });
  });
});

describe('buildCatalog — rules & states', () => {
  test('derives rule entries from an aggregate\'s diagram-node invariants', async () => {
    const rules = (await buildCatalog(sourcesWithGit)).filter((e) => e.cat === 'rule' && e.rkind === 'rule');
    expect(rules).toHaveLength(2);
    expect(rules.map((r) => r.title)).toEqual(['total must be non-negative', 'at least one line item']);
    expect(rules[0].ctx).toBe('Ordering');
  });

  test('derives state entries from an enum\'s members', async () => {
    const states = (await buildCatalog(sourcesWithGit)).filter((e) => e.cat === 'rule' && e.rkind === 'state');
    expect(states.map((s) => s.title)).toEqual(['Draft', 'Placed']);
  });
});

describe('buildCatalog — commands', () => {
  test('maps registry commands to action entries, carrying the command id + hint', async () => {
    const actions = (await buildCatalog(sourcesWithGit)).filter((e) => e.cat === 'action');
    expect(actions).toEqual([
      {
        id: 'cmd:palette.newModel', cat: 'action', title: 'New model', sub: 'File',
        keywords: 'new model file', cmdId: 'palette.newModel', hint: '⌘N',
      },
      {
        id: 'cmd:palette.format', cat: 'action', title: 'Format document', sub: 'Editor',
        keywords: 'format document editor', cmdId: 'palette.format', hint: undefined,
      },
    ]);
  });
});

describe('buildCatalog — files', () => {
  test('maps workspace files to file entries, splitting the basename from the directory', async () => {
    const fileEntries = (await buildCatalog(sourcesWithGit)).filter((e) => e.cat === 'file');
    expect(fileEntries).toEqual([
      {
        id: 'file:file:///ws/src/Ordering/Order.koi', cat: 'file', title: 'Order.koi',
        sub: 'src/Ordering', ctx: 'src/Ordering', keywords: 'src/ordering/order.koi',
        file: 'file:///ws/src/Ordering/Order.koi',
      },
      {
        id: 'file:file:///ws/README.md', cat: 'file', title: 'README.md',
        sub: '', ctx: '', keywords: 'readme.md', file: 'file:///ws/README.md',
      },
    ]);
  });
});

describe('buildCatalog — glossary', () => {
  test('maps glossary terms to glossary entries carrying their doc text', async () => {
    const glossary = (await buildCatalog(sourcesWithGit)).filter((e) => e.cat === 'glossary');
    const order = glossary.find((e) => e.qualifiedName === 'Ordering.Order');
    expect(order).toMatchObject({
      id: 'gloss:Ordering.Order', cat: 'glossary', title: 'Order', sub: 'glossary term',
      doc: 'The order aggregate root.',
    });
    expect(order?.keywords).toContain('order aggregate root');
  });
});

describe('buildCatalog — commits', () => {
  test('maps git log entries to commit entries, newest first, carrying the sha', async () => {
    const commits = (await buildCatalog(sourcesWithGit)).filter((e) => e.cat === 'commit');
    expect(commits).toEqual([
      {
        id: 'commit:abc1234567890', cat: 'commit', title: 'feat: add shipping event',
        sub: 'abc1234 · Ada Lovelace', ctx: 'Ada Lovelace', hash: 'abc1234567890',
        keywords: 'feat: add shipping event abc1234567890',
      },
      {
        id: 'commit:def0987654321', cat: 'commit', title: 'fix: rounding bug',
        sub: 'def0987 · Alan Turing', ctx: 'Alan Turing', hash: 'def0987654321',
        keywords: 'fix: rounding bug def0987654321',
      },
    ]);
  });

  test('omits every commit entry when canUseGit is false, even if gitLog somehow returned data', async () => {
    const commits = (await buildCatalog(sourcesNoGit)).filter((e) => e.cat === 'commit');
    expect(commits).toEqual([]);
  });
});

describe('buildCatalog — pure join', () => {
  test('a fake source set with no real host still produces a full catalog across every category', async () => {
    const catalog = await buildCatalog(sourcesWithGit);
    const cats = new Set(catalog.map((e) => e.cat));
    expect(cats).toEqual(new Set(['action', 'symbol', 'event', 'rule', 'file', 'glossary', 'commit']));
  });

  test('imports only types from the lsp/host client modules — never KoineLsp or a Platform impl', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'buildCatalog.ts'), 'utf8');
    // No value import of the live LSP client class or a concrete platform/shell module.
    expect(src).not.toMatch(/\bKoineLsp\b/);
    expect(src).not.toMatch(/from ['"]@\/host\/(tauri|browser)/);
    expect(src).not.toMatch(/from ['"]@\/shell\//);
    // Every import from outside `@/launcher/` (the lsp/host/model/koine-ui seams) is `import type` —
    // the only allowed VALUE import is the pure `catalog` module (for `KIND`).
    const importLines = src.split('\n').filter((l) => /^import /.test(l) && !/from ['"]@\/launcher\//.test(l));
    for (const line of importLines) {
      expect(line).toMatch(/^import type /);
    }
  });

  test('every .ts file under src/launcher only ever value-imports from other launcher modules or vitest', () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    const files2 = readdirSync(dir).filter((f) => /\.ts$/.test(f) && !/\.test\.ts$/.test(f));
    for (const file of files2) {
      const full = join(dir, file);
      if (statSync(full).isDirectory()) continue;
      const src = readFileSync(full, 'utf8');
      const valueImports = src
        .split('\n')
        .filter((l) => /^import (?!type )/.test(l));
      for (const line of valueImports) {
        expect(line).toMatch(/from ['"]@\/launcher\//);
      }
    }
  });
});
