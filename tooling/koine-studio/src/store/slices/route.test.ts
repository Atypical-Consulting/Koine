import { describe, it, expect } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { routeFromHash, hashFromRoute, resolveInitialRoute, createRouteSlice, type RouteSlice } from './route';
import type { StartupView } from '@/settings/persistence';

const makeRouteStore = () => createStore<RouteSlice>((set, get) => createRouteSlice(set, get));

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
  it('pristine first load (empty hash) → home', () => {
    expect(resolveInitialRoute('')).toBe('home');
  });
  it('the home hash (#/) → home', () => {
    expect(resolveInitialRoute('#/')).toBe('home');
  });
  it('an explicit #/editor deep-link → editor', () => {
    expect(resolveInitialRoute('#/editor')).toBe('editor');
  });
  it('an unknown hash → home (never strands the user on a blank editor)', () => {
    expect(resolveInitialRoute('#/nope')).toBe('home');
  });
  it('a previously-open workspace no longer forces the editor — opening always lands on Home (#766)', () => {
    // Was: resolveInitialRoute({ hash: '', hasPersistedWorkspace: true }) === 'editor'. The persisted
    // flag is no longer a routing input; the returning-user fast path is now the Resume control on Home.
    expect(resolveInitialRoute('')).toBe('home');
  });
});

describe('resolveInitialRoute with startupView opts (#770)', () => {
  it('no opts → always home (backward-compatible with existing callers)', () => {
    expect(resolveInitialRoute('')).toBe('home');
    expect(resolveInitialRoute('#/')).toBe('home');
  });

  it('explicit #/editor always wins, regardless of opts', () => {
    expect(resolveInitialRoute('#/editor')).toBe('editor');
    expect(resolveInitialRoute('#/editor', { startupView: 'home', hasWorkspace: true })).toBe('editor');
    expect(resolveInitialRoute('#/editor', { startupView: 'lastWorkspace', hasWorkspace: false })).toBe('editor');
  });

  it('lastWorkspace + workspace persisted → editor (opt-in auto-resume)', () => {
    const opts: { startupView: StartupView; hasWorkspace: boolean } = { startupView: 'lastWorkspace', hasWorkspace: true };
    expect(resolveInitialRoute('', opts)).toBe('editor');
    expect(resolveInitialRoute('#/', opts)).toBe('editor');
    expect(resolveInitialRoute('#/unknown', opts)).toBe('editor');
  });

  it('lastWorkspace + NO workspace persisted → home (never strand on blank editor)', () => {
    expect(resolveInitialRoute('', { startupView: 'lastWorkspace', hasWorkspace: false })).toBe('home');
  });

  it('home + workspace persisted → home (default unchanged for non-opted-in users)', () => {
    expect(resolveInitialRoute('', { startupView: 'home', hasWorkspace: true })).toBe('home');
  });

  it('home + no workspace → home', () => {
    expect(resolveInitialRoute('', { startupView: 'home', hasWorkspace: false })).toBe('home');
  });

  it('opts with only startupView (no hasWorkspace) → home because hasWorkspace is falsy', () => {
    expect(resolveInitialRoute('', { startupView: 'lastWorkspace' })).toBe('home');
  });
});

describe('navigate() reflects the route in location.hash (refresh / back-forward stable)', () => {
  it('navigate("editor") sets the store route and the hash to #/editor', () => {
    location.hash = '';
    const store = makeRouteStore();
    store.getState().navigate('editor');
    expect(store.getState().route).toBe('editor');
    expect(location.hash).toBe('#/editor');
  });
  it('navigate("home") sets the store route and the hash to #/', () => {
    const store = makeRouteStore();
    store.getState().navigate('home');
    expect(store.getState().route).toBe('home');
    expect(location.hash).toBe('#/');
  });
});
