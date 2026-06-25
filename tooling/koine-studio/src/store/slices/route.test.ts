import { describe, it, expect } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { routeFromHash, hashFromRoute, resolveInitialRoute, createRouteSlice, type RouteSlice } from './route';

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
