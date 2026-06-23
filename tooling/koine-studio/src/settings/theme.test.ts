// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { applyTheme, initTheme, currentTheme, toggleTheme, setTheme, onThemeChange } from '@/settings/theme';
import { loadSettings, saveSettings, DEFAULT_SETTINGS } from '@/settings/persistence';

// The active theme drives `document.documentElement.dataset.theme`. Read it back through this helper so
// each assertion checks the real DOM mutation rather than the module's cached `active` value.
const domTheme = () => document.documentElement.dataset.theme;

describe('theme apply + DOM mutation', () => {
  beforeEach(() => {
    localStorage.clear();
    // Re-baseline the document root so a prior test's flip can't leak into the next assertion.
    applyTheme('dark');
  });

  it('applyTheme writes the theme onto the document root dataset', () => {
    applyTheme('light');
    expect(domTheme()).toBe('light');
    applyTheme('dark');
    expect(domTheme()).toBe('dark');
  });

  it('currentTheme reflects the last applied theme without re-reading storage', () => {
    applyTheme('light');
    expect(currentTheme()).toBe('light');
    applyTheme('dark');
    expect(currentTheme()).toBe('dark');
  });
});

describe('initTheme', () => {
  beforeEach(() => {
    localStorage.clear();
    applyTheme('dark');
  });

  it('applies and returns the persisted theme on a fresh (default) store', () => {
    // No stored blob → loadSettings() yields the default ('dark').
    const t = initTheme();
    expect(t).toBe('dark');
    expect(domTheme()).toBe('dark');
    expect(currentTheme()).toBe('dark');
  });

  it('honours a persisted non-default theme', () => {
    saveSettings({ ...DEFAULT_SETTINGS, theme: 'light' });
    const t = initTheme();
    expect(t).toBe('light');
    expect(domTheme()).toBe('light');
  });
});

describe('setTheme', () => {
  beforeEach(() => {
    localStorage.clear();
    applyTheme('dark');
  });

  it('persists, applies, and notifies listeners with the explicit theme', () => {
    const seen: string[] = [];
    onThemeChange((t) => seen.push(t));

    setTheme('light');

    expect(domTheme()).toBe('light'); // applied to the DOM
    expect(currentTheme()).toBe('light');
    expect(loadSettings().theme).toBe('light'); // persisted
    expect(seen).toEqual(['light']); // listener fired exactly once with the new value
  });
});

describe('toggleTheme', () => {
  beforeEach(() => {
    localStorage.clear();
    applyTheme('dark');
  });

  it('flips dark → light, persisting and applying the result', () => {
    const next = toggleTheme();
    expect(next).toBe('light');
    expect(currentTheme()).toBe('light');
    expect(domTheme()).toBe('light');
    expect(loadSettings().theme).toBe('light');
  });

  it('flips light → dark', () => {
    applyTheme('light'); // start from light
    const next = toggleTheme();
    expect(next).toBe('dark');
    expect(domTheme()).toBe('dark');
    expect(loadSettings().theme).toBe('dark');
  });

  it('notifies a registered listener with the toggled value', () => {
    const seen: string[] = [];
    onThemeChange((t) => seen.push(t));
    toggleTheme(); // dark → light
    expect(seen).toEqual(['light']);
  });
});

describe('onThemeChange registry', () => {
  beforeEach(() => {
    localStorage.clear();
    applyTheme('dark');
  });

  it('fires every registered callback on each change', () => {
    const a: string[] = [];
    const b: string[] = [];
    onThemeChange((t) => a.push(t));
    onThemeChange((t) => b.push(t));

    setTheme('light');
    setTheme('dark');

    expect(a).toEqual(['light', 'dark']);
    expect(b).toEqual(['light', 'dark']);
  });
});
