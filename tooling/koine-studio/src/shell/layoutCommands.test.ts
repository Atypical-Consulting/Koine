import { describe, expect, test, vi } from 'vitest';
import { layoutCommands, type LayoutActions } from '@/shell/layoutCommands';
import { createCommandRegistry } from '@/shared/commandRegistry';

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
