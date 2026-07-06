// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { applyTheme, initTheme, currentTheme, toggleTheme, setTheme } from '@/settings/theme';
import { loadSettings, saveSettings, DEFAULT_SETTINGS } from '@/settings/persistence';
import { appStore } from '@/store/index';

// The active theme drives `document.documentElement.dataset.theme`. Read it back through this helper so
// each assertion checks the real DOM mutation rather than the store's cached `theme` field.
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

  it('currentTheme reflects the last applied theme via the store field', () => {
    applyTheme('light');
    expect(currentTheme()).toBe('light');
    expect(appStore.getState().theme).toBe('light');
    applyTheme('dark');
    expect(currentTheme()).toBe('dark');
    expect(appStore.getState().theme).toBe('dark');
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

  it('seeds the uiChrome store field from Settings', () => {
    saveSettings({ ...DEFAULT_SETTINGS, theme: 'light' });
    initTheme();
    expect(appStore.getState().theme).toBe('light');
  });
});

describe('setTheme', () => {
  beforeEach(() => {
    localStorage.clear();
    applyTheme('dark');
  });

  it('persists, applies, and publishes the explicit theme to the store', () => {
    setTheme('light');

    expect(domTheme()).toBe('light'); // applied to the DOM
    expect(currentTheme()).toBe('light');
    expect(appStore.getState().theme).toBe('light'); // published to the store field
    expect(loadSettings().theme).toBe('light'); // persisted
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
});

describe('theme store subscription', () => {
  beforeEach(() => {
    localStorage.clear();
    applyTheme('dark');
  });

  // The bus is now a plain store subscription: a subscriber registered BEFORE the changes captures
  // every transition, and — unlike the old leak-shaped listener Set — its returned disposer stops it.
  it('fires on each change and its unsubscribe stops further notifications', () => {
    const seen: string[] = [];
    const unsub = appStore.subscribe((s, prev) => {
      if (s.theme !== prev.theme) seen.push(s.theme);
    });

    setTheme('light');
    setTheme('dark');
    expect(seen).toEqual(['light', 'dark']);

    unsub();
    setTheme('light'); // no subscriber left → not captured
    expect(seen).toEqual(['light', 'dark']);
  });
});
