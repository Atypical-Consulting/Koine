import { describe, it, expect } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { createUiChromeSlice, type UiChromeSlice } from './uiChrome';

// The gear-launched Settings page (#482) is a TRANSIENT overlay over the Deck v2 center, NOT a deck
// surface: it rides an orthogonal `settingsOpen` flag, never enters the deck/`center`, and is cleared by
// focusing any surface — so it can never leak into the persisted center/deck.
describe('uiChrome settings overlay (#482)', () => {
  const make = () => createStore<UiChromeSlice>((set, get) => createUiChromeSlice(set, get));

  it('showSettings opens the overlay WITHOUT touching the deck or center', () => {
    const store = make();
    store.getState().focusPrimary('technical');
    store.getState().showSettings();
    expect(store.getState().settingsOpen).toBe(true);
    // The deck (and the legacy `center` mirror) stay on the real surface — nothing to persist, nothing to
    // restore-reject.
    expect(store.getState().deck.primary).toBe('technical');
    expect(store.getState().center).toBe('technical');
  });

  it('focusing any deck surface clears the overlay (the natural way back)', () => {
    const store = make();
    store.getState().showSettings();
    expect(store.getState().settingsOpen).toBe(true);
    store.getState().focusPrimary('docs');
    expect(store.getState().settingsOpen).toBe(false);
    expect(store.getState().deck.primary).toBe('docs');
  });

  it('closeSettings hides the overlay', () => {
    const store = make();
    store.getState().showSettings();
    store.getState().closeSettings();
    expect(store.getState().settingsOpen).toBe(false);
  });

  // #731: a category lands the overlay on a specific tab (the About deep-link); a plain open clears it so
  // the pane falls back to its last-used / default tab rather than re-forcing the previous deep-link.
  it('defaults to no forced category', () => {
    expect(make().getState().settingsCategory).toBeNull();
  });

  it('showSettings(category) records the landing category alongside opening the overlay', () => {
    const store = make();
    store.getState().showSettings('about');
    expect(store.getState().settingsOpen).toBe(true);
    expect(store.getState().settingsCategory).toBe('about');
  });

  it('showSettings() with no category clears any previously forced category', () => {
    const store = make();
    store.getState().showSettings('about');
    store.getState().showSettings();
    expect(store.getState().settingsOpen).toBe(true);
    expect(store.getState().settingsCategory).toBeNull();
  });
});
