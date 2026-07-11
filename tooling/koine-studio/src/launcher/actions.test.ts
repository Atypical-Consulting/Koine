// Per-result quick actions (issue #1143, task 6): `actionsFor` ported from the prototype's
// `actionsFor(e)` — README §2 "Per-result quick actions" documents the ordered lists this asserts.
import { describe, expect, test, vi } from 'vitest';
import { actionsFor, type LauncherActionDeps } from '@/launcher/actions';
import type { CatalogEntry } from '@/launcher/catalog';

const RANGE = { start: { line: 4, character: 0 }, end: { line: 4, character: 5 } };

function makeDeps(over: Partial<LauncherActionDeps> = {}): LauncherActionDeps {
  return {
    gotoDefinition: vi.fn(),
    findUsages: vi.fn(),
    peek: vi.fn(),
    rename: vi.fn(),
    copy: vi.fn(),
    openFile: vi.fn(),
    openFileChanges: vi.fn(),
    revealFile: vi.fn(),
    openGlossary: vi.fn(),
    findInModel: vi.fn(),
    gotoRule: vi.fn(),
    viewCommit: vi.fn(),
    revertCommit: vi.fn(),
    runCommand: vi.fn(),
    toast: vi.fn(),
    ...over,
  };
}

function labelsAndKeycaps(entry: CatalogEntry, deps: LauncherActionDeps): [string, string][] {
  return actionsFor(entry, deps).map((a) => [a.label, a.keycap]);
}

describe('actionsFor — per-category ordered lists (README §2)', () => {
  test('symbol', () => {
    const entry: CatalogEntry = {
      id: 'sym:Ordering.Order', cat: 'symbol', kind: 'aggregate', title: 'Order',
      qualifiedName: 'Ordering.Order', nameRange: RANGE,
    };
    expect(labelsAndKeycaps(entry, makeDeps())).toEqual([
      ['Go to definition', '↵'],
      ['Find usages', '⇧↵'],
      ['Peek', '⌥↵'],
      ['Rename symbol', 'F2'],
      ['Copy name', '⌘C'],
    ]);
  });

  test('event', () => {
    const entry: CatalogEntry = { id: 'evt:Ordering.OrderPlaced', cat: 'event', kind: 'event', title: 'OrderPlaced' };
    expect(labelsAndKeycaps(entry, makeDeps())).toEqual([
      ['Go to definition', '↵'],
      ['Show producers & consumers', '⇧↵'],
      ['Trace flow', '⌥↵'],
    ]);
  });

  test('action', () => {
    const entry: CatalogEntry = { id: 'cmd:new-file', cat: 'action', title: 'New file', cmdId: 'cmd:new-file' };
    expect(labelsAndKeycaps(entry, makeDeps())).toEqual([['Run', '↵']]);
  });

  test('file', () => {
    const entry: CatalogEntry = { id: 'file:ordering.koi', cat: 'file', title: 'ordering.koi', sub: 'src/Ordering', file: 'file:///ws/src/Ordering/ordering.koi' };
    expect(labelsAndKeycaps(entry, makeDeps())).toEqual([
      ['Open', '↵'],
      ['Open changes', '⇧↵'],
      ['Reveal in Explorer', '⌥↵'],
      ['Copy path', '⌘C'],
    ]);
  });

  test('glossary', () => {
    const entry: CatalogEntry = { id: 'gloss:Ordering.Order', cat: 'glossary', title: 'Order', qualifiedName: 'Ordering.Order' };
    expect(labelsAndKeycaps(entry, makeDeps())).toEqual([
      ['Open glossary', '↵'],
      ['Find in model', '⇧↵'],
    ]);
  });

  test('rule', () => {
    const entry: CatalogEntry = { id: 'rule:Ordering.Order:inv:0', cat: 'rule', rkind: 'rule', title: 'total must be positive' };
    expect(labelsAndKeycaps(entry, makeDeps())).toEqual([
      ['Go to rule', '↵'],
      ['Peek', '⌥↵'],
    ]);
  });

  test('commit', () => {
    const entry: CatalogEntry = { id: 'commit:abc1234', cat: 'commit', title: 'feat: add shipping event', hash: 'abc1234567890' };
    expect(labelsAndKeycaps(entry, makeDeps())).toEqual([
      ['View commit', '↵'],
      ['Copy hash', '⌘C'],
      ['Revert', '⇧⌫'],
    ]);
  });

  test('index 0 is always the default action', () => {
    const symbolEntry: CatalogEntry = { id: 'sym:x', cat: 'symbol', kind: 'value', title: 'Money' };
    const fileEntry: CatalogEntry = { id: 'file:x', cat: 'file', title: 'x.koi' };
    expect(actionsFor(symbolEntry, makeDeps())[0].label).toBe('Go to definition');
    expect(actionsFor(fileEntry, makeDeps())[0].label).toBe('Open');
  });
});

describe('actionsFor — run() calls the injected deps', () => {
  test("a symbol's default (Go to definition) calls gotoDefinition with the full entry, carrying qualifiedName/nameRange", async () => {
    const deps = makeDeps();
    const entry: CatalogEntry = {
      id: 'sym:Ordering.Order', cat: 'symbol', kind: 'aggregate', title: 'Order',
      qualifiedName: 'Ordering.Order', nameRange: RANGE,
    };

    await actionsFor(entry, deps)[0].run();

    expect(deps.gotoDefinition).toHaveBeenCalledTimes(1);
    const called = (deps.gotoDefinition as ReturnType<typeof vi.fn>).mock.calls[0][0] as CatalogEntry;
    expect(called.qualifiedName).toBe('Ordering.Order');
    expect(called.nameRange).toEqual(RANGE);
  });

  test("a symbol's Copy name calls deps.copy with the title and confirms via deps.toast", async () => {
    const deps = makeDeps();
    const entry: CatalogEntry = { id: 'sym:x', cat: 'symbol', kind: 'value', title: 'Money' };

    await actionsFor(entry, deps)[4].run();

    expect(deps.copy).toHaveBeenCalledWith('Money');
    expect(deps.toast).toHaveBeenCalledTimes(1);
    expect((deps.toast as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain('Money');
  });

  test("a file's Copy path calls deps.copy with the workspace-relative path and triggers deps.toast", async () => {
    const deps = makeDeps();
    const entry: CatalogEntry = { id: 'file:x', cat: 'file', title: 'ordering.koi', sub: 'src/Ordering' };

    await actionsFor(entry, deps)[3].run();

    expect(deps.copy).toHaveBeenCalledWith('src/Ordering/ordering.koi');
    expect(deps.toast).toHaveBeenCalledTimes(1);
  });

  test("a file with no sub directory copies just its title", async () => {
    const deps = makeDeps();
    const entry: CatalogEntry = { id: 'file:x', cat: 'file', title: 'root.koi' };

    await actionsFor(entry, deps)[3].run();

    expect(deps.copy).toHaveBeenCalledWith('root.koi');
  });

  test("a file whose relPath diverges from sub+title uses relPath instead", async () => {
    const deps = makeDeps();
    const entry: CatalogEntry = {
      id: 'file:x',
      cat: 'file',
      title: 'other.koi',
      sub: 'display/dir',
      relPath: 'src/deep/ordering.koi',
    };

    await actionsFor(entry, deps)[3].run();

    expect(deps.copy).toHaveBeenCalledWith('src/deep/ordering.koi');
    expect(deps.toast).toHaveBeenCalledTimes(1);
    expect((deps.toast as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain('src/deep/ordering.koi');
  });

  test("a commit's Copy hash calls deps.copy with the full sha and triggers deps.toast", async () => {
    const deps = makeDeps();
    const entry: CatalogEntry = { id: 'commit:abc', cat: 'commit', title: 'chore: x', hash: 'abc1234567890' };

    await actionsFor(entry, deps)[1].run();

    expect(deps.copy).toHaveBeenCalledWith('abc1234567890');
    expect(deps.toast).toHaveBeenCalledTimes(1);
  });

  test("a commit's Revert calls deps.revertCommit with the entry", async () => {
    const deps = makeDeps();
    const entry: CatalogEntry = { id: 'commit:abc', cat: 'commit', title: 'chore: x', hash: 'abc1234567890' };

    await actionsFor(entry, deps)[2].run();

    expect(deps.revertCommit).toHaveBeenCalledWith(entry);
  });

  test("an action entry's Run calls deps.runCommand with the entry", async () => {
    const deps = makeDeps();
    const entry: CatalogEntry = { id: 'cmd:new-file', cat: 'action', title: 'New file', cmdId: 'cmd:new-file' };

    await actionsFor(entry, deps)[0].run();

    expect(deps.runCommand).toHaveBeenCalledWith(entry);
  });

  test('a rule entry Peek calls deps.peek with the entry', async () => {
    const deps = makeDeps();
    const entry: CatalogEntry = { id: 'rule:x', cat: 'rule', rkind: 'rule', title: 'x' };

    await actionsFor(entry, deps)[1].run();

    expect(deps.peek).toHaveBeenCalledWith(entry);
  });

  test('a glossary entry Find in model calls deps.findInModel with the entry', async () => {
    const deps = makeDeps();
    const entry: CatalogEntry = { id: 'gloss:x', cat: 'glossary', title: 'Money' };

    await actionsFor(entry, deps)[1].run();

    expect(deps.findInModel).toHaveBeenCalledWith(entry);
  });

  test('an event Trace flow calls deps.peek with the entry', async () => {
    const deps = makeDeps();
    const entry: CatalogEntry = { id: 'evt:x', cat: 'event', kind: 'event', title: 'OrderPlaced' };

    await actionsFor(entry, deps)[2].run();

    expect(deps.peek).toHaveBeenCalledWith(entry);
  });
});
