import { describe, expect, test, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { layoutCommands, type LayoutActions } from '@/shell/layoutCommands';
import { createCommandRegistry } from '@atypical/koine-ui';
import { createUiChromeSlice, type UiChromeSlice } from '@/store/slices/uiChrome';

function spyActions(): LayoutActions {
  return {
    togglePanelSide: vi.fn(),
    toggleSideRail: vi.fn(),
    toggleProperties: vi.fn(),
    toggleNavigator: vi.fn(),
  };
}

describe('layoutCommands', () => {
  test('returns the view-layout commands with their stable, pinned ids in order', () => {
    const ids = layoutCommands(spyActions()).map((c) => c.id);
    expect(ids).toEqual([
      'layout.panelSide',
      'layout.sideRail',
      'layout.toggleProperties',
      'layout.toggleNavigator',
    ]);
  });

  test('each run() invokes exactly its matching layout action', () => {
    const actions = spyActions();
    const by = (id: string) => layoutCommands(actions).find((c) => c.id === id)!;
    by('layout.panelSide').run();
    expect(actions.togglePanelSide).toHaveBeenCalledOnce();
    by('layout.toggleNavigator').run();
    expect(actions.toggleNavigator).toHaveBeenCalledOnce();
  });

  test('every command registers cleanly into a fresh registry and is retrievable by id', () => {
    const registry = createCommandRegistry();
    const cmds = layoutCommands(spyActions());
    for (const c of cmds) registry.register(c);
    for (const c of cmds) expect(registry.get(c.id)).toBe(c);
    expect(registry.all().map((c) => c.id)).toEqual(cmds.map((c) => c.id));
  });
});

// Relocated from shared/palette.test.ts during the @atypical/koine-ui primitives extraction (#905
// Task 3): these tests exercise layoutCommands' store wiring, which depends on Studio's own
// uiChrome slice — a Studio-specific dependency that must not live in the published koine-ui
// package, so this coverage stays here alongside the rest of layoutCommands' tests.
describe('layoutCommands — the view-layout palette commands', () => {
  // Spy actions: one vi.fn() per LayoutActions method.
  function spyActions(): LayoutActions {
    return {
      togglePanelSide: vi.fn(),
      toggleSideRail: vi.fn(),
      toggleProperties: vi.fn(),
      toggleNavigator: vi.fn(),
    };
  }

  // The exact ids the shell pins (so the palette/help/anything keyed on them stay stable), paired with
  // the action each command must invoke.
  const wiring: { id: string; action: keyof LayoutActions }[] = [
    { id: 'layout.panelSide', action: 'togglePanelSide' },
    { id: 'layout.sideRail', action: 'toggleSideRail' },
    { id: 'layout.toggleProperties', action: 'toggleProperties' },
    { id: 'layout.toggleNavigator', action: 'toggleNavigator' },
  ];

  test('returns exactly the layout commands, by id', () => {
    const cmds = layoutCommands(spyActions());
    expect(cmds.map((c) => c.id)).toEqual(wiring.map((w) => w.id));
  });

  test('the Toggle Properties panel command, wired to the store, flips rightCollapsed (#500)', () => {
    const store = createStore<UiChromeSlice>((set, get) => createUiChromeSlice(set, get));
    const cmd = layoutCommands({
      ...spyActions(),
      toggleProperties: () => store.getState().toggleRightCollapsed(),
    }).find((c) => c.id === 'layout.toggleProperties')!;
    expect(cmd.title).toBe('Toggle Properties panel');
    expect(store.getState().rightCollapsed).toBe(false);
    cmd.run();
    expect(store.getState().rightCollapsed).toBe(true);
  });

  test('the Toggle navigator rail command, wired to the store, flips leftCollapsed (#730)', () => {
    const store = createStore<UiChromeSlice>((set, get) => createUiChromeSlice(set, get));
    const cmd = layoutCommands({
      ...spyActions(),
      toggleNavigator: () => store.getState().toggleLeftCollapsed(),
    }).find((c) => c.id === 'layout.toggleNavigator')!;
    expect(cmd.title).toBe('Toggle navigator rail');
    expect(store.getState().leftCollapsed).toBe(false);
    cmd.run();
    expect(store.getState().leftCollapsed).toBe(true);
  });

  test('every command carries a non-empty title', () => {
    const cmds = layoutCommands(spyActions());
    expect(cmds.every((c) => typeof c.title === 'string' && c.title.length > 0)).toBe(true);
  });

  test.each(wiring)('command $id run() calls only the $action action, exactly once', ({ id, action }) => {
    const actions = spyActions();
    const cmd = layoutCommands(actions).find((c) => c.id === id)!;
    expect(cmd).toBeDefined();

    cmd.run();

    expect(actions[action]).toHaveBeenCalledTimes(1);
    // No other action fired.
    for (const other of Object.keys(actions) as (keyof LayoutActions)[]) {
      if (other !== action) expect(actions[other]).not.toHaveBeenCalled();
    }
  });
});
