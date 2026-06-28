import { describe, expect, test } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { createAppStore } from '@/store/index';
import {
  createUiChromeSlice,
  DEFAULT_CENTER,
  DEFAULT_CENTER_LAYOUT,
  DEFAULT_MOBILE_ZONE,
  isValidCenter,
  isValidCenterLayout,
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
    s.getState().setRight('notes');
    expect(s.getState().bottom).toBe('events');
    expect(s.getState().right).toBe('notes');
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

describe('center layout', () => {
  test('default layout is a single visual pane equal to DEFAULT_CENTER_LAYOUT', () => {
    const s = make();
    expect(s.getState().centerLayout).toEqual(DEFAULT_CENTER_LAYOUT);
    expect(s.getState().centerLayout.panes).toHaveLength(1);
    expect(s.getState().centerLayout.panes[0].view).toBe('visual');
    expect(s.getState().centerLayout.sizes).toEqual([1]);
  });

  test('splitCenter("row") yields 2 panes with normalized sizes (each 0.5)', () => {
    const s = make();
    s.getState().splitCenter('row');
    expect(s.getState().centerLayout.panes).toHaveLength(2);
    expect(s.getState().centerLayout.orientation).toBe('row');
    for (const size of s.getState().centerLayout.sizes) {
      expect(size).toBeCloseTo(0.5);
    }
  });

  test('setCenterPreset(["technical","visual"],"row") yields the Code ⟷ Canvas layout', () => {
    const s = make();
    s.getState().setCenterPreset(['technical', 'visual'], 'row');
    const { centerLayout } = s.getState();
    expect(centerLayout.panes.map((p) => p.view)).toEqual(['technical', 'visual']);
    expect(centerLayout.orientation).toBe('row');
    expect(centerLayout.sizes).toEqual([0.5, 0.5]);
    // The first pane takes focus, and the legacy `center` mirror follows it.
    expect(centerLayout.focusedPaneId).toBe(centerLayout.panes[0].id);
    expect(s.getState().center).toBe('technical');
  });

  test('setCenterPreset dedupes repeated views (two panes can\'t share one center host)', () => {
    const s = make();
    s.getState().setCenterPreset(['visual', 'visual', 'docs'], 'row');
    expect(s.getState().centerLayout.panes.map((p) => p.view)).toEqual(['visual', 'docs']);
  });

  test('setCenterPreset with a single view collapses to one pane (like Reset)', () => {
    const s = make();
    s.getState().splitCenter('row'); // go to 2 panes first
    s.getState().setCenterPreset(['visual'], 'row');
    expect(s.getState().centerLayout.panes).toHaveLength(1);
    expect(s.getState().centerLayout.sizes).toEqual([1]);
  });

  test('setPaneView changes only the targeted pane view', () => {
    const s = make();
    s.getState().splitCenter('row');
    const panes = s.getState().centerLayout.panes;
    const firstId = panes[0].id;
    const secondId = panes[1].id;
    s.getState().setPaneView(secondId, 'docs');
    const updated = s.getState().centerLayout.panes;
    expect(updated.find((p) => p.id === firstId)!.view).toBe('visual');
    expect(updated.find((p) => p.id === secondId)!.view).toBe('docs');
  });

  test('resizeCenter updates sizes', () => {
    const s = make();
    s.getState().splitCenter('row');
    s.getState().resizeCenter([0.3, 0.7]);
    const { sizes } = s.getState().centerLayout;
    expect(sizes[0]).toBeCloseTo(0.3);
    expect(sizes[1]).toBeCloseTo(0.7);
  });

  test('resizeCenter normalizes when sizes array is too long (extra size is dropped)', () => {
    const s = make();
    s.getState().splitCenter('row');
    // pass 3 sizes for 2 panes — extra should be dropped, remainder normalized
    s.getState().resizeCenter([0.4, 0.4, 0.2]);
    const { sizes } = s.getState().centerLayout;
    expect(sizes).toHaveLength(2);
    const total = sizes.reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1);
  });

  test('resizeCenter normalizes when sizes array is too short (missing size filled in)', () => {
    const s = make();
    s.getState().splitCenter('row');
    // pass 1 size for 2 panes — missing slot filled with 0.5, then normalized
    s.getState().resizeCenter([0.6]);
    const { sizes } = s.getState().centerLayout;
    expect(sizes).toHaveLength(2);
    const total = sizes.reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1);
  });

  test('closePane collapses back to single pane when there are 2 panes', () => {
    const s = make();
    s.getState().splitCenter('row');
    const panes = s.getState().centerLayout.panes;
    s.getState().closePane(panes[1].id);
    expect(s.getState().centerLayout.panes).toHaveLength(1);
    expect(s.getState().centerLayout.sizes).toEqual([1]);
  });

  test('focusPane updates focusedPaneId', () => {
    const s = make();
    s.getState().splitCenter('row');
    const panes = s.getState().centerLayout.panes;
    const secondId = panes[1].id;
    s.getState().focusPane(secondId);
    expect(s.getState().centerLayout.focusedPaneId).toBe(secondId);
  });

  test('isValidCenterLayout rejects null, missing panes, empty panes array, unknown view value', () => {
    expect(isValidCenterLayout(null)).toBe(false);
    expect(isValidCenterLayout({})).toBe(false);
    expect(isValidCenterLayout({ orientation: 'row', panes: [], sizes: [], focusedPaneId: 'x' })).toBe(false);
    expect(
      isValidCenterLayout({
        orientation: 'row',
        panes: [{ id: 'p', view: 'unknown-view' }],
        sizes: [1],
        focusedPaneId: 'p',
      }),
    ).toBe(false);
    expect(isValidCenterLayout(DEFAULT_CENTER_LAYOUT)).toBe(true);
  });

  test('isValidCenterLayout rejects a stale focusedPaneId that references no pane', () => {
    // A persisted layout where the focused pane was removed (e.g. after a code change that renamed
    // IDs) should fail validation so the consumer falls back to DEFAULT_CENTER_LAYOUT.
    expect(
      isValidCenterLayout({
        orientation: 'row',
        panes: [{ id: 'pane-1', view: 'visual' }],
        sizes: [1],
        focusedPaneId: 'stale-id-not-in-panes',
      }),
    ).toBe(false);
  });

  test('splitCenter gives the new pane a view distinct from the existing pane', () => {
    const s = make();
    // The initial single pane is 'visual'; the new pane must not also be 'visual'.
    s.getState().splitCenter('row');
    const panes = s.getState().centerLayout.panes;
    expect(panes).toHaveLength(2);
    expect(panes[0].view).toBe('visual');
    expect(panes[1].view).not.toBe('visual');
  });

  test('legacy setCenter sets the focused pane view', () => {
    const s = make();
    s.getState().setCenter('technical');
    expect(s.getState().center).toBe('technical');
    expect(s.getState().centerLayout.panes[0].view).toBe('technical');
  });

  test('setTech sets tech sub-view AND focused pane view to "technical"', () => {
    const s = make();
    s.getState().setTech('scenarios');
    expect(s.getState().tech).toBe('scenarios');
    expect(s.getState().center).toBe('technical');
    expect(s.getState().centerLayout.panes[0].view).toBe('technical');
  });

  test('setOutput sets the output sub-view AND focused pane view to "output"', () => {
    const s = make();
    s.getState().setOutput('compatibility');
    expect(s.getState().output).toBe('compatibility');
    expect(s.getState().center).toBe('output');
    expect(s.getState().centerLayout.panes[0].view).toBe('output');
  });
});
