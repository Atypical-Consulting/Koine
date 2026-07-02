import { describe, expect, test, vi } from 'vitest';
import { createCommandRegistry, type Command } from './commandRegistry';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cmd(id: string, title: string, extra: Partial<Command> = {}): Command {
  return { id, title, run: vi.fn(), ...extra };
}

// ---------------------------------------------------------------------------
// 1. register / get / all — basic CRUD and ordering
// ---------------------------------------------------------------------------

describe('register / get / all', () => {
  test('get returns the command after registration', () => {
    const registry = createCommandRegistry();
    const c = cmd('a', 'Alpha');
    registry.register(c);
    expect(registry.get('a')).toBe(c);
  });

  test('get returns undefined for an unknown id', () => {
    const registry = createCommandRegistry();
    expect(registry.get('nope')).toBeUndefined();
  });

  test('all() returns all registered commands', () => {
    const registry = createCommandRegistry();
    const a = cmd('a', 'Alpha');
    const b = cmd('b', 'Beta');
    registry.register(a);
    registry.register(b);
    expect(registry.all()).toEqual([a, b]);
  });

  test('all() preserves registration order', () => {
    const registry = createCommandRegistry();
    const ids = ['z', 'a', 'm'];
    ids.forEach((id) => registry.register(cmd(id, id)));
    expect(registry.all().map((c) => c.id)).toEqual(ids);
  });

  test('all() returns an empty array when nothing is registered', () => {
    const registry = createCommandRegistry();
    expect(registry.all()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. Duplicate-id guard and disposer
// ---------------------------------------------------------------------------

describe('duplicate id guard and disposer', () => {
  test('registering a duplicate id throws', () => {
    const registry = createCommandRegistry();
    registry.register(cmd('dup', 'First'));
    expect(() => registry.register(cmd('dup', 'Second'))).toThrow();
  });

  test('the disposer removes the command from get()', () => {
    const registry = createCommandRegistry();
    const dispose = registry.register(cmd('x', 'X'));
    expect(registry.get('x')).toBeDefined();
    dispose();
    expect(registry.get('x')).toBeUndefined();
  });

  test('the disposer removes the command from all()', () => {
    const registry = createCommandRegistry();
    registry.register(cmd('a', 'A'));
    const dispose = registry.register(cmd('b', 'B'));
    registry.register(cmd('c', 'C'));
    dispose();
    expect(registry.all().map((c) => c.id)).toEqual(['a', 'c']);
  });

  test('after disposing, the same id can be re-registered', () => {
    const registry = createCommandRegistry();
    const dispose = registry.register(cmd('reuse', 'First'));
    dispose();
    expect(() => registry.register(cmd('reuse', 'Second'))).not.toThrow();
    expect(registry.get('reuse')?.title).toBe('Second');
  });
});

// ---------------------------------------------------------------------------
// 3. isEnabled / run / when predicate
// ---------------------------------------------------------------------------

describe('isEnabled', () => {
  test('returns true when no when() predicate is provided', () => {
    const registry = createCommandRegistry();
    registry.register(cmd('always', 'Always'));
    expect(registry.isEnabled('always')).toBe(true);
  });

  test('returns true when when() returns true', () => {
    const registry = createCommandRegistry();
    registry.register(cmd('cond', 'Cond', { when: () => true }));
    expect(registry.isEnabled('cond')).toBe(true);
  });

  test('returns false when when() returns false', () => {
    const registry = createCommandRegistry();
    registry.register(cmd('disabled', 'Disabled', { when: () => false }));
    expect(registry.isEnabled('disabled')).toBe(false);
  });

  test('evaluates when() dynamically on each call', () => {
    const registry = createCommandRegistry();
    let flag = false;
    registry.register(cmd('dyn', 'Dynamic', { when: () => flag }));
    expect(registry.isEnabled('dyn')).toBe(false);
    flag = true;
    expect(registry.isEnabled('dyn')).toBe(true);
  });

  test('returns false for an unknown id', () => {
    const registry = createCommandRegistry();
    expect(registry.isEnabled('unknown')).toBe(false);
  });
});

describe('all() is unfiltered', () => {
  test('all() includes commands whose when() returns false', () => {
    const registry = createCommandRegistry();
    registry.register(cmd('on', 'On', { when: () => true }));
    registry.register(cmd('off', 'Off', { when: () => false }));
    expect(registry.all().map((c) => c.id)).toEqual(['on', 'off']);
  });
});

describe('run', () => {
  test('run() invokes the command when enabled', () => {
    const registry = createCommandRegistry();
    const c = cmd('go', 'Go');
    registry.register(c);
    registry.run('go');
    expect(c.run).toHaveBeenCalledTimes(1);
  });

  test('run() does NOT invoke run() when when() returns false', () => {
    const registry = createCommandRegistry();
    const c = cmd('no', 'No', { when: () => false });
    registry.register(c);
    registry.run('no');
    expect(c.run).not.toHaveBeenCalled();
  });

  test('run() is a guarded no-op (does not throw) for an unknown id', () => {
    const registry = createCommandRegistry();
    expect(() => registry.run('ghost')).not.toThrow();
  });

  test('run() is a guarded no-op (does not throw) for a disabled command', () => {
    const registry = createCommandRegistry();
    const c = cmd('off', 'Off', { when: () => false });
    registry.register(c);
    expect(() => registry.run('off')).not.toThrow();
    expect(c.run).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 4. Command interface shape — optional fields
// ---------------------------------------------------------------------------

describe('Command interface optional fields', () => {
  test('category field is accepted on a Command', () => {
    const registry = createCommandRegistry();
    const c: Command = { id: 'cat', title: 'Cat', run: vi.fn(), category: 'view' };
    expect(() => registry.register(c)).not.toThrow();
    expect(registry.get('cat')?.category).toBe('view');
  });

  test('hint and group fields are accepted on a Command', () => {
    const registry = createCommandRegistry();
    const c: Command = { id: 'hg', title: 'HG', run: vi.fn(), hint: 'Ctrl+H', group: 'nav' };
    registry.register(c);
    const got = registry.get('hg');
    expect(got?.hint).toBe('Ctrl+H');
    expect(got?.group).toBe('nav');
  });
});
