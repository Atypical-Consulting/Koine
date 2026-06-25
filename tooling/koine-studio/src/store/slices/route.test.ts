import { describe, it, expect } from 'vitest';
import { routeFromHash, hashFromRoute, resolveInitialRoute } from './route';

describe('route helpers', () => {
  it('maps hashes to routes', () => {
    expect(routeFromHash('')).toBe('home');
    expect(routeFromHash('#/')).toBe('home');
    expect(routeFromHash('#/editor')).toBe('editor');
    expect(routeFromHash('#/bogus')).toBe('home'); // unknown → home
  });
  it('maps routes back to hashes', () => {
    expect(hashFromRoute('home')).toBe('#/');
    expect(hashFromRoute('editor')).toBe('#/editor');
  });
});

describe('resolveInitialRoute', () => {
  it('pristine first load → home', () => {
    expect(resolveInitialRoute({ hash: '', hasPersistedWorkspace: false })).toBe('home');
  });
  it('explicit #/editor → editor', () => {
    expect(resolveInitialRoute({ hash: '#/editor', hasPersistedWorkspace: false })).toBe('editor');
  });
  it('a previously-open workspace → editor', () => {
    expect(resolveInitialRoute({ hash: '', hasPersistedWorkspace: true })).toBe('editor');
  });
});
