import { describe, expect, test } from 'vitest';
import { createEditSession, newFileKey, newFileKeyInRoot, parseNewFileKey } from './editSession';

describe('createEditSession', () => {
  test('list() returns the initial relPaths in insertion order', () => {
    const session = createEditSession({
      'order.koi': 'context Order {}',
      'billing.koi': 'context Billing {}',
    });
    expect(session.list()).toEqual(['order.koi', 'billing.koi']);
  });

  test('read() returns the initial body, then the staged body after stage()', () => {
    const session = createEditSession({ 'order.koi': 'context Order {}' });
    expect(session.read('order.koi')).toBe('context Order {}');

    session.stage('order.koi', 'context Order { entity Line }');
    expect(session.read('order.koi')).toBe('context Order { entity Line }');
  });

  test('read() returns null for an unknown, never-staged relPath', () => {
    const session = createEditSession({ 'order.koi': 'context Order {}' });
    expect(session.read('missing.koi')).toBeNull();
  });

  test('staging a new relPath appends it to list() and dedups', () => {
    const session = createEditSession({ 'order.koi': 'context Order {}' });
    session.stage('billing.koi', 'context Billing {}');
    session.stage('billing.koi', 'context Billing { value Money }');
    expect(session.list()).toEqual(['order.koi', 'billing.koi']);
    expect(session.read('billing.koi')).toBe('context Billing { value Money }');
  });

  test('staged() flags new vs modified files correctly', () => {
    const session = createEditSession({ 'order.koi': 'context Order {}' });
    session.stage('order.koi', 'context Order { entity Line }'); // modifies an initial file
    session.stage('billing.koi', 'context Billing {}'); // brand-new file

    const staged = session.staged();
    expect(staged).toEqual([
      // Without a display map the key IS the relPath (legacy single-root behavior, #472).
      { key: 'order.koi', relPath: 'order.koi', body: 'context Order { entity Line }', isNew: false },
      { key: 'billing.koi', relPath: 'billing.koi', body: 'context Billing {}', isNew: true },
    ]);
  });

  test('staged() keeps the latest body when a relPath is staged twice', () => {
    const session = createEditSession({});
    session.stage('a.koi', 'first');
    session.stage('a.koi', 'second');
    expect(session.staged()).toEqual([{ key: 'a.koi', relPath: 'a.koi', body: 'second', isNew: true }]);
  });

  test('stage() rejects absolute and parent-traversal relPaths', () => {
    const session = createEditSession({ 'order.koi': 'context Order {}' });
    expect(() => session.stage('/etc/passwd', 'x')).toThrow();
    expect(() => session.stage('C:\\Windows\\system32', 'x')).toThrow();
    expect(() => session.stage('../secret.koi', 'x')).toThrow();
    expect(() => session.stage('nested/../../escape.koi', 'x')).toThrow();
  });

  test('read() rejects absolute and parent-traversal relPaths', () => {
    const session = createEditSession({ 'order.koi': 'context Order {}' });
    expect(() => session.read('/etc/passwd')).toThrow();
    expect(() => session.read('../secret.koi')).toThrow();
  });

  test('clear() empties staging so staged() is [] and read() falls back to initial', () => {
    const session = createEditSession({ 'order.koi': 'context Order {}' });
    session.stage('order.koi', 'context Order { entity Line }');
    session.stage('billing.koi', 'context Billing {}');

    session.clear();

    expect(session.staged()).toEqual([]);
    expect(session.read('order.koi')).toBe('context Order {}'); // back to initial
    expect(session.read('billing.koi')).toBeNull(); // staged-only file is gone
    expect(session.list()).toEqual(['order.koi']);
  });

  test('stage() rejects an empty/blank relPath', () => {
    const session = createEditSession({ 'order.koi': 'context Order {}' });
    expect(() => session.stage('', 'x')).toThrow();
    expect(() => session.stage('   ', 'x')).toThrow();
  });

  test('stage() rejects a non-.koi relPath (the assistant edits the .koi model, not project files)', () => {
    const session = createEditSession({ 'order.koi': 'context Order {}' });
    expect(() => session.stage('README.md', '# hi')).toThrow();
    expect(() => session.stage('package.json', '{}')).toThrow();
    expect(() => session.stage('nested/notes.txt', 'x')).toThrow();
    expect(() => session.stage('nested/billing.koi', 'context Billing {}')).not.toThrow();
  });

  test('isNew() reflects absence from the initial workspace', () => {
    const session = createEditSession({ 'order.koi': 'context Order {}' });
    expect(session.isNew('order.koi')).toBe(false); // an existing file
    expect(session.isNew('billing.koi')).toBe(true); // not in the initial snapshot
  });

  test('version() starts at 0 and bumps on stage() — new key and re-staged key alike', () => {
    const session = createEditSession({ 'order.koi': 'context Order {}' });
    expect(session.version()).toBe(0);

    session.stage('order.koi', 'context Order { entity Line }');
    expect(session.version()).toBe(1);

    session.stage('billing.koi', 'context Billing {}');
    expect(session.version()).toBe(2);

    session.stage('billing.koi', 'context Billing { value Money }'); // re-stage the same key
    expect(session.version()).toBe(3);
  });

  test('version() bumps on clear()', () => {
    const session = createEditSession({ 'order.koi': 'context Order {}' });
    session.stage('order.koi', 'context Order { entity Line }');
    const beforeClear = session.version();

    session.clear();

    expect(session.version()).toBe(beforeClear + 1);
  });

  test('version() is unchanged after a stage() rejected by the safety/extension guards', () => {
    const session = createEditSession({ 'order.koi': 'context Order {}' });
    const before = session.version();

    expect(() => session.stage('/etc/passwd', 'x')).toThrow();
    expect(() => session.stage('../secret.koi', 'x')).toThrow();
    expect(() => session.stage('README.md', '# hi')).toThrow();
    expect(() => session.stage('', 'x')).toThrow();

    expect(session.version()).toBe(before);
  });
});

describe('multi-root keying (#472): opaque keys + display relPaths', () => {
  test('two distinct keys sharing the same display relPath stay independent', () => {
    const session = createEditSession(
      { a: 'context A {}', b: 'context B {}' },
      { a: 'model.koi', b: 'model.koi' },
    );
    expect(session.read('a')).toBe('context A {}');
    expect(session.read('b')).toBe('context B {}');

    session.stage('a', 'context A { entity E }');
    expect(session.read('a')).toBe('context A { entity E }');
    expect(session.read('b')).toBe('context B {}'); // the same-relPath sibling is untouched
  });

  test('staged() entries carry both key and the display-resolved relPath; unknown keys are isNew', () => {
    const session = createEditSession({ a: 'context A {}' }, { a: 'model.koi' });
    session.stage('a', 'context A { entity E }');
    session.stage('new:nested/extra.koi', 'context Extra {}'); // a brand-new file, key minted by the caller

    expect(session.staged()).toEqual([
      { key: 'a', relPath: 'model.koi', body: 'context A { entity E }', isNew: false },
      { key: 'new:nested/extra.koi', relPath: 'nested/extra.koi', body: 'context Extra {}', isNew: true },
    ]);
    expect(session.isNew('a')).toBe(false);
    expect(session.isNew('new:nested/extra.koi')).toBe(true);
    expect(session.list()).toEqual(['a', 'new:nested/extra.koi']);
  });

  test('without a display entry the relPath falls back to the key itself (legacy single-root)', () => {
    const session = createEditSession({ 'order.koi': 'context Order {}' });
    session.stage('order.koi', 'context Order { entity Line }');
    expect(session.staged()).toEqual([
      { key: 'order.koi', relPath: 'order.koi', body: 'context Order { entity Line }', isNew: false },
    ]);
  });

  test('staging a brand-new file still rejects an unsafe resolved relPath', () => {
    const session = createEditSession({}, {});
    expect(() => session.stage('new:/etc/passwd.koi', 'x')).toThrow(); // absolute
    expect(() => session.stage('new:../escape.koi', 'x')).toThrow(); // parent traversal
    expect(() => session.stage('new:C:\\evil.koi', 'x')).toThrow(); // Windows drive
  });

  test('relPathOf() resolves a key through the display map, strips a new-file prefix, else echoes the key', () => {
    const session = createEditSession(
      { 'mem://a/model.koi': 'context A {}' },
      { 'mem://a/model.koi': 'model.koi' },
    );
    expect(session.relPathOf('mem://a/model.koi')).toBe('model.koi'); // display entry wins
    expect(session.relPathOf(newFileKey('shared/events.koi'))).toBe('shared/events.koi'); // prefix stripped
    expect(session.relPathOf('orders.koi')).toBe('orders.koi'); // legacy key === relPath
  });

  test('newFileKey() mints the key the session resolves back to the same relPath', () => {
    expect(newFileKey('nested/extra.koi')).toBe('new:nested/extra.koi');

    const session = createEditSession({});
    session.stage(newFileKey('nested/extra.koi'), 'context Extra {}');
    expect(session.staged()).toEqual([
      { key: 'new:nested/extra.koi', relPath: 'nested/extra.koi', body: 'context Extra {}', isNew: true },
    ]);
  });
});

describe('root-qualified new-file keys (#1132): new-in: prefix', () => {
  test('newFileKeyInRoot() mints new-in:<encoded root>:<relPath>', () => {
    expect(newFileKeyInRoot('opfs:ws/a', 'nested/x.koi')).toBe(
      `new-in:${encodeURIComponent('opfs:ws/a')}:nested/x.koi`,
    );
  });

  test('parseNewFileKey() resolves a new: key to { relPath, root: null }', () => {
    expect(parseNewFileKey(newFileKey('nested/extra.koi'))).toEqual({
      relPath: 'nested/extra.koi',
      root: null,
    });
  });

  test('parseNewFileKey() resolves a new-in: key to { relPath, root: <decoded root> }', () => {
    expect(parseNewFileKey(newFileKeyInRoot('opfs:ws/a', 'nested/x.koi'))).toEqual({
      relPath: 'nested/x.koi',
      root: 'opfs:ws/a',
    });
  });

  test('parseNewFileKey() returns null for a plain/legacy key that is neither prefix', () => {
    expect(parseNewFileKey('order.koi')).toBeNull(); // bare relPath
    expect(parseNewFileKey('mem://a/model.koi')).toBeNull(); // legacy buffer uri
  });

  test('parseNewFileKey() returns null for a malformed new-in: key with no root/relPath separator', () => {
    // Unreachable via newFileKeyInRoot itself (it always inserts the separator), but the parser's
    // contract is "null for anything it can't confidently split" — pin that for a hand-crafted key.
    expect(parseNewFileKey('new-in:onlyRootNoSeparator')).toBeNull();
  });

  test('a root token containing ":" and "/" survives an encode/decode round trip', () => {
    const key = newFileKeyInRoot('opfs:ws/a/b', 'nested/x.koi');
    expect(parseNewFileKey(key)).toEqual({ relPath: 'nested/x.koi', root: 'opfs:ws/a/b' });
  });

  test('relPathOf()/stage() resolve the real relPath through a new-in: key', () => {
    const session = createEditSession({});
    const key = newFileKeyInRoot('rootA', 'nested/x.koi');

    session.stage(key, 'context Extra {}');

    expect(session.relPathOf(key)).toBe('nested/x.koi');
    expect(session.read(key)).toBe('context Extra {}');
    expect(session.isNew(key)).toBe(true);
  });

  test('stage() still rejects an unsafe or non-.koi relPath reached via a new-in: key', () => {
    const session = createEditSession({});
    expect(() => session.stage(newFileKeyInRoot('rootA', '/etc/passwd.koi'), 'x')).toThrow(); // absolute
    expect(() => session.stage(newFileKeyInRoot('rootA', '../escape.koi'), 'x')).toThrow(); // parent traversal
    expect(() => session.stage(newFileKeyInRoot('rootA', 'notes.txt'), 'x')).toThrow(); // non-.koi
  });
});
