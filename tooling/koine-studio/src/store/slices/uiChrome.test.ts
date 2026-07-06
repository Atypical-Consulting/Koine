import { describe, expect, test } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { createAppStore } from '@/store/index';
import {
  createUiChromeSlice,
  DEFAULT_CENTER,
  DEFAULT_DECK_STATE,
  DEFAULT_MOBILE_ZONE,
  DEFAULT_SETTINGS_EDITOR_MODE,
  DEFAULT_SETTINGS_JSON_SCOPE,
  isValidCenter,
  isValidDeckState,
  isValidMobileZone,
  type UiChromeSlice,
} from '@/store/slices/uiChrome';

const make = () => createStore<UiChromeSlice>((set, get) => createUiChromeSlice(set, get));

describe('uiChrome slice', () => {
  test('center defaults to Visual and setCenter switches it', () => {
    const s = make();
    expect(s.getState().center).toBe(DEFAULT_CENTER);
    expect(DEFAULT_CENTER).toBe('visual');
    s.getState().setCenter('technical');
    expect(s.getState().center).toBe('technical');
  });

  test('isValidCenter accepts real panes and rejects everything else', () => {
    expect(isValidCenter('visual')).toBe(true);
    expect(isValidCenter('technical')).toBe(true);
    expect(isValidCenter('docs')).toBe(true);
    expect(isValidCenter('domain')).toBe(false); // an old persisted mode id is not a center
    expect(isValidCenter('')).toBe(false);
  });

  test('tab setters are independent', () => {
    const s = make();
    s.getState().setBottom('events');
    s.getState().setRight('source-control');
    expect(s.getState().bottom).toBe('events');
    expect(s.getState().right).toBe('source-control');
  });

  test('outlineFilter defaults to empty and is set independently (it survives panel remounts)', () => {
    const s = make();
    expect(s.getState().outlineFilter).toBe('');
    s.getState().setOutlineFilter('Order');
    expect(s.getState().outlineFilter).toBe('Order');
    s.getState().setOutlineFilter('');
    expect(s.getState().outlineFilter).toBe('');
  });

  test('rightCollapsed defaults to false and setRightCollapsed switches it', () => {
    const s = make();
    expect(s.getState().rightCollapsed).toBe(false);
    s.getState().setRightCollapsed(true);
    expect(s.getState().rightCollapsed).toBe(true);
    s.getState().setRightCollapsed(false);
    expect(s.getState().rightCollapsed).toBe(false);
  });

  test('toggleRightCollapsed flips the flag', () => {
    const s = make();
    expect(s.getState().rightCollapsed).toBe(false);
    s.getState().toggleRightCollapsed();
    expect(s.getState().rightCollapsed).toBe(true);
    s.getState().toggleRightCollapsed();
    expect(s.getState().rightCollapsed).toBe(false);
  });

  test('toggling collapse leaves the active right view unchanged (collapse is independent of the view)', () => {
    const s = make();
    s.getState().setRight('source-control');
    s.getState().toggleRightCollapsed();
    expect(s.getState().rightCollapsed).toBe(true);
    expect(s.getState().right).toBe('source-control');
  });

  test('leftCollapsed defaults to false and setLeftCollapsed switches it (#730)', () => {
    const s = make();
    expect(s.getState().leftCollapsed).toBe(false);
    s.getState().setLeftCollapsed(true);
    expect(s.getState().leftCollapsed).toBe(true);
    s.getState().setLeftCollapsed(false);
    expect(s.getState().leftCollapsed).toBe(false);
  });

  test('toggleLeftCollapsed flips the flag independently of rightCollapsed', () => {
    const s = make();
    expect(s.getState().leftCollapsed).toBe(false);
    s.getState().toggleLeftCollapsed();
    expect(s.getState().leftCollapsed).toBe(true);
    expect(s.getState().rightCollapsed).toBe(false);
    s.getState().toggleLeftCollapsed();
    expect(s.getState().leftCollapsed).toBe(false);
  });
});

describe('uiChrome railAxis / diagCollapsed / contextMapView (#983)', () => {
  test('railAxis defaults to domain and setRailAxis switches it', () => {
    const s = make();
    expect(s.getState().railAxis).toBe('domain');
    s.getState().setRailAxis('files');
    expect(s.getState().railAxis).toBe('files');
    s.getState().setRailAxis('domain');
    expect(s.getState().railAxis).toBe('domain');
  });

  test('diagCollapsed defaults to false and diagCollapsedPref to null (no explicit choice yet)', () => {
    const s = make();
    expect(s.getState().diagCollapsed).toBe(false);
    expect(s.getState().diagCollapsedPref).toBeNull();
  });

  test('setDiagCollapsed sets BOTH the runtime flag and the explicit preference', () => {
    const s = make();
    s.getState().setDiagCollapsed(true);
    expect(s.getState().diagCollapsed).toBe(true);
    expect(s.getState().diagCollapsedPref).toBe(true);
    s.getState().setDiagCollapsed(false);
    expect(s.getState().diagCollapsed).toBe(false);
    expect(s.getState().diagCollapsedPref).toBe(false);
  });

  test('applyDiagCollapsedDefault changes ONLY the runtime flag while the preference is unset', () => {
    const s = make();
    s.getState().applyDiagCollapsedDefault(true);
    expect(s.getState().diagCollapsed).toBe(true);
    expect(s.getState().diagCollapsedPref).toBeNull(); // runtime-only: no preference is recorded
  });

  test('applyDiagCollapsedDefault is a NO-OP once an explicit preference exists (the user always wins)', () => {
    const s = make();
    s.getState().setDiagCollapsed(false); // the user explicitly chose "expanded"
    s.getState().applyDiagCollapsedDefault(true); // the #475 narrow-Docs default would collapse it...
    expect(s.getState().diagCollapsed).toBe(false); // ...but the preference wins; runtime is untouched
    expect(s.getState().diagCollapsedPref).toBe(false);
  });

  test('contextMapView defaults to graph and setContextMapView round-trips', () => {
    const s = make();
    expect(s.getState().contextMapView).toBe('graph');
    s.getState().setContextMapView('table');
    expect(s.getState().contextMapView).toBe('table');
    s.getState().setContextMapView('graph');
    expect(s.getState().contextMapView).toBe('graph');
  });
});

describe('uiChrome panelSide / sideRail (#983)', () => {
  test('panelSide defaults to bottom (matching DEFAULT_LAYOUT) and setPanelSide round-trips', () => {
    const s = make();
    expect(s.getState().panelSide).toBe('bottom');
    s.getState().setPanelSide('right');
    expect(s.getState().panelSide).toBe('right');
    s.getState().setPanelSide('bottom');
    expect(s.getState().panelSide).toBe('bottom');
  });

  test('togglePanelSide flips bottom↔right', () => {
    const s = make();
    expect(s.getState().panelSide).toBe('bottom');
    s.getState().togglePanelSide();
    expect(s.getState().panelSide).toBe('right');
    s.getState().togglePanelSide();
    expect(s.getState().panelSide).toBe('bottom');
  });

  test('sideRail defaults to right (matching DEFAULT_LAYOUT) and setSideRail round-trips', () => {
    const s = make();
    expect(s.getState().sideRail).toBe('right');
    s.getState().setSideRail('left');
    expect(s.getState().sideRail).toBe('left');
    s.getState().setSideRail('right');
    expect(s.getState().sideRail).toBe('right');
  });

  test('toggleSideRail flips right↔left independently of panelSide', () => {
    const s = make();
    expect(s.getState().sideRail).toBe('right');
    s.getState().toggleSideRail();
    expect(s.getState().sideRail).toBe('left');
    expect(s.getState().panelSide).toBe('bottom'); // untouched
    s.getState().toggleSideRail();
    expect(s.getState().sideRail).toBe('right');
  });
});

describe('uiChrome settingsEditorMode / settingsJsonScope (#983)', () => {
  test('settingsEditorMode defaults to visual and setSettingsEditorMode round-trips', () => {
    const s = make();
    expect(s.getState().settingsEditorMode).toBe('visual');
    expect(DEFAULT_SETTINGS_EDITOR_MODE).toBe('visual');
    s.getState().setSettingsEditorMode('json');
    expect(s.getState().settingsEditorMode).toBe('json');
    s.getState().setSettingsEditorMode('visual');
    expect(s.getState().settingsEditorMode).toBe('visual');
  });

  test('settingsJsonScope defaults to user and setSettingsJsonScope round-trips', () => {
    const s = make();
    expect(s.getState().settingsJsonScope).toBe('user');
    expect(DEFAULT_SETTINGS_JSON_SCOPE).toBe('user');
    s.getState().setSettingsJsonScope('workspace');
    expect(s.getState().settingsJsonScope).toBe('workspace');
    s.getState().setSettingsJsonScope('user');
    expect(s.getState().settingsJsonScope).toBe('user');
  });
});

describe('uiChrome mobileZone', () => {
  test('defaults to code', () => {
    const store = createAppStore();
    expect(store.getState().mobileZone).toBe('code');
    expect(DEFAULT_MOBILE_ZONE).toBe('code');
  });
  test('setMobileZone updates the field', () => {
    const store = createAppStore();
    store.getState().setMobileZone('diagram');
    expect(store.getState().mobileZone).toBe('diagram');
  });
  test('isValidMobileZone guards bad values', () => {
    expect(isValidMobileZone('files')).toBe(true);
    expect(isValidMobileZone('nope')).toBe(false);
  });
});

describe('deck', () => {
  test('default deck is a 1-up on Visual equal to DEFAULT_DECK_STATE', () => {
    const s = make();
    expect(s.getState().deck).toEqual(DEFAULT_DECK_STATE);
    expect(s.getState().deck.primary).toBe('visual');
    expect(s.getState().deck.secondary).toBeNull();
    expect(s.getState().center).toBe('visual');
  });

  test('focusPrimary focuses a surface 1-up and mirrors `center`', () => {
    const s = make();
    s.getState().openBeside('technical'); // go to a 2-up first
    s.getState().focusPrimary('docs');
    const { deck, center } = s.getState();
    expect(deck.primary).toBe('docs');
    expect(deck.secondary).toBeNull();
    expect(deck.flipped).toBe(false);
    expect(deck.mode).toBe('focus');
    expect(center).toBe('docs');
  });

  test('openBeside opens a 2-up; opening the same surface again closes it; opening the primary is a no-op', () => {
    const s = make();
    s.getState().openBeside('technical'); // Visual primary, Technical secondary
    expect(s.getState().deck.secondary).toBe('technical');
    s.getState().openBeside('technical'); // toggles it off
    expect(s.getState().deck.secondary).toBeNull();
    s.getState().openBeside('visual'); // the primary — no-op
    expect(s.getState().deck.secondary).toBeNull();
  });

  test('closeSurface drops the secondary, or promotes the secondary when closing the primary', () => {
    const s = make();
    s.getState().focusPrimary('technical');
    s.getState().openBeside('visual'); // primary=technical, secondary=visual
    s.getState().closeSurface('visual'); // drop the secondary
    expect(s.getState().deck.secondary).toBeNull();
    expect(s.getState().deck.primary).toBe('technical');

    s.getState().openBeside('visual'); // back to 2-up
    s.getState().closeSurface('technical'); // close the primary → secondary promoted
    expect(s.getState().deck.primary).toBe('visual');
    expect(s.getState().deck.secondary).toBeNull();
  });

  test('swapSides flips left/right but keeps the selection; no-op in a 1-up', () => {
    const s = make();
    s.getState().focusPrimary('technical');
    s.getState().swapSides(); // 1-up — no-op
    expect(s.getState().deck.flipped).toBe(false);
    s.getState().openBeside('visual');
    s.getState().swapSides();
    expect(s.getState().deck.flipped).toBe(true);
    expect(s.getState().deck.primary).toBe('technical'); // selection unchanged
  });

  test('selectPane promotes the OTHER pane to primary, compensating flipped so neither moves', () => {
    const s = make();
    s.getState().focusPrimary('technical');
    s.getState().openBeside('visual'); // primary=technical (left), secondary=visual (right)
    s.getState().selectPane('visual'); // select the right pane
    const { deck, center } = s.getState();
    expect(deck.primary).toBe('visual');
    expect(deck.secondary).toBe('technical');
    expect(deck.flipped).toBe(true); // compensated so the panes don't move
    expect(center).toBe('visual');
  });

  test('selectPane is a no-op for the primary, a 1-up, or a surface not in the pair', () => {
    const s = make();
    s.getState().focusPrimary('technical');
    s.getState().selectPane('technical'); // 1-up — no-op
    expect(s.getState().deck.secondary).toBeNull();
    s.getState().openBeside('visual');
    s.getState().selectPane('technical'); // already primary — no-op
    expect(s.getState().deck.primary).toBe('technical');
    s.getState().selectPane('docs'); // not in the pair — no-op
    expect(s.getState().deck.primary).toBe('technical');
  });

  test('setRatio clamps to the [0.2, 0.8] band', () => {
    const s = make();
    s.getState().setRatio(0.05);
    expect(s.getState().deck.ratio).toBeCloseTo(0.2);
    s.getState().setRatio(0.95);
    expect(s.getState().deck.ratio).toBeCloseTo(0.8);
    s.getState().setRatio(0.42);
    expect(s.getState().deck.ratio).toBeCloseTo(0.42);
  });

  test('toggleOverview / setDeckMode switch the bird\'s-eye mode', () => {
    const s = make();
    s.getState().toggleOverview();
    expect(s.getState().deck.mode).toBe('overview');
    s.getState().toggleOverview();
    expect(s.getState().deck.mode).toBe('focus');
    s.getState().setDeckMode('overview');
    expect(s.getState().deck.mode).toBe('overview');
  });

  test('isValidDeckState validates shape and rejects bad values', () => {
    expect(isValidDeckState(null)).toBe(false);
    expect(isValidDeckState({})).toBe(false);
    expect(isValidDeckState(DEFAULT_DECK_STATE)).toBe(true);
    expect(isValidDeckState({ mode: 'focus', primary: 'technical', secondary: 'visual', ratio: 0.5, flipped: false })).toBe(true);
    // a surface can't be both panes
    expect(isValidDeckState({ mode: 'focus', primary: 'visual', secondary: 'visual', ratio: 0.5, flipped: false })).toBe(false);
    // unknown view
    expect(isValidDeckState({ mode: 'focus', primary: 'nope', secondary: null, ratio: 0.5, flipped: false })).toBe(false);
    // out-of-range ratio
    expect(isValidDeckState({ mode: 'focus', primary: 'visual', secondary: null, ratio: 1.5, flipped: false })).toBe(false);
  });

  test('legacy setCenter focuses the surface 1-up and mirrors `center`', () => {
    const s = make();
    s.getState().setCenter('technical');
    expect(s.getState().center).toBe('technical');
    expect(s.getState().deck.primary).toBe('technical');
  });

  test('setTech sets the facet AND brings Code up when it is not shown', () => {
    const s = make();
    s.getState().setTech('scenarios');
    expect(s.getState().tech).toBe('scenarios');
    expect(s.getState().deck.primary).toBe('technical');
    expect(s.getState().center).toBe('technical');
  });

  test('setTech only changes the facet when Code is already shown (no layout change)', () => {
    const s = make();
    s.getState().focusPrimary('visual');
    s.getState().openBeside('technical'); // Code is the secondary now
    const before = s.getState().deck;
    s.getState().setTech('scenarios');
    expect(s.getState().tech).toBe('scenarios');
    expect(s.getState().deck).toEqual(before); // layout untouched — selection not stolen
  });

  test('setOutput brings Output up when it is not shown', () => {
    const s = make();
    s.getState().setOutput('compatibility');
    expect(s.getState().output).toBe('compatibility');
    expect(s.getState().deck.primary).toBe('output');
    expect(s.getState().center).toBe('output');
  });
});
