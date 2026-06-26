import { describe, expect, test } from 'vitest';
import { createEditSession } from './editSession';

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
      { relPath: 'order.koi', body: 'context Order { entity Line }', isNew: false },
      { relPath: 'billing.koi', body: 'context Billing {}', isNew: true },
    ]);
  });

  test('staged() keeps the latest body when a relPath is staged twice', () => {
    const session = createEditSession({});
    session.stage('a.koi', 'first');
    session.stage('a.koi', 'second');
    expect(session.staged()).toEqual([{ relPath: 'a.koi', body: 'second', isNew: true }]);
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
});
