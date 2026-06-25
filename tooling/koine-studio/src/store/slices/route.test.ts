import { describe, it, expect } from 'vitest';
import { routeFromHash, hashFromRoute } from './route';

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
