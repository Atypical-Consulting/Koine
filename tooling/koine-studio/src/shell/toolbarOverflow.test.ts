import { afterEach, describe, expect, test, vi } from 'vitest';
import type { Command } from '@atypical/koine-ui';
import {
  buildOverflowItems,
  closeOverflowMenu,
  isOverflowMenuOpen,
  openOverflowMenu,
  toggleOverflowMenu,
  type OverflowMenuItem,
} from '@/shell/toolbarOverflow';

// A minimal command registry mirroring the ids the toolbar's secondary actions reuse from ide.tsx.
function cmds(overrides: Partial<Record<string, () => void>> = {}): Command[] {
  const mk = (id: string, title: string): Command => ({ id, title, run: overrides[id] ?? (() => {}) });
  return [
    mk('save-project-to-disk', 'Save to disk…'),
    mk('check', 'Check against baseline…'),
    mk('toggle-theme', 'Toggle theme'),
    mk('prefs', 'Settings…'),
    mk('generate-project', 'Generate project…'), // present in the registry but stays INLINE — never in the menu
  ];
}

afterEach(() => {
  closeOverflowMenu(false);
  document.body.replaceChildren();
});

describe('buildOverflowItems', () => {
  test('collects exactly the secondary toolbar actions, in issue order', () => {
    const items = buildOverflowItems({
      commands: cmds(),
      openPalette: () => {},
      installAvailable: true,
      install: () => {},
    });
    expect(items.map((i) => i.id)).toEqual([
      'save-project-to-disk',
      'check',
      'install',
      'palette',
      'toggle-theme',
      'prefs',
    ]);
    // The inline-kept primary action is never duplicated into the menu.
    expect(items.some((i) => i.id === 'generate-project')).toBe(false);
  });

  test('omits the Install item when the install affordance is not revealed (#442 gating)', () => {
    const items = buildOverflowItems({
      commands: cmds(),
      openPalette: () => {},
      installAvailable: false,
      install: () => {},
    });
    expect(items.some((i) => i.id === 'install')).toBe(false);
  });

  test('omits Save to disk when the platform has no save-project command', () => {
    const without = cmds().filter((c) => c.id !== 'save-project-to-disk');
    const items = buildOverflowItems({
      commands: without,
      openPalette: () => {},
      installAvailable: false,
      install: () => {},
    });
    expect(items.some((i) => i.id === 'save-project-to-disk')).toBe(false);
  });

  // A command gated by enabled() (issue #1407 — the SECOND, independent activatability axis, distinct
  // from when()/isEnabled which already decided the command is even in `commands` at all) must never
  // surface here as a plain, silently-inert menu item. None of the four commands this menu currently
  // reuses (save-project-to-disk / check / toggle-theme / prefs) are enabled()-gated today, but the
  // mapping must handle one correctly regardless — defense-in-depth for whatever command this menu
  // reuses next.
  test('propagates a command\'s enabled() as the item\'s disabled flag', () => {
    const gated = cmds().map((c) => (c.id === 'check' ? { ...c, enabled: () => false } : c));
    const items = buildOverflowItems({
      commands: gated,
      openPalette: () => {},
      installAvailable: true,
      install: () => {},
    });
    expect(items.find((i) => i.id === 'check')!.disabled).toBe(true);
    expect(items.find((i) => i.id === 'save-project-to-disk')!.disabled).toBe(false);
  });

  test('a command with no enabled() field is never disabled', () => {
    const items = buildOverflowItems({
      commands: cmds(),
      openPalette: () => {},
      installAvailable: true,
      install: () => {},
    });
    // 'install'/'palette' are synthetic (not built via fromCmd) and carry no `disabled` field at all —
    // falsy either way is the contract (createFloatingMenu treats `disabled ?? false` identically).
    expect(items.every((i) => !i.disabled)).toBe(true);
  });

  test('an enabled()-gated item\'s run() re-checks fresh at activation time and no-ops when disabled', () => {
    let busy = true;
    const onCheck = vi.fn();
    const gated = cmds({ check: onCheck }).map((c) => (c.id === 'check' ? { ...c, enabled: () => !busy } : c));
    const items = buildOverflowItems({
      commands: gated,
      openPalette: () => {},
      installAvailable: false,
      install: () => {},
    });
    const check = items.find((i) => i.id === 'check')!;

    check.run();
    expect(onCheck).not.toHaveBeenCalled();

    busy = false;
    check.run();
    expect(onCheck).toHaveBeenCalledOnce();
  });

  test('each item reuses the registered handler (palette + install wired to their thunks)', () => {
    const onCheck = vi.fn();
    const onPalette = vi.fn();
    const onInstall = vi.fn();
    const items = buildOverflowItems({
      commands: cmds({ check: onCheck }),
      openPalette: onPalette,
      installAvailable: true,
      install: onInstall,
    });
    items.find((i) => i.id === 'check')!.run();
    items.find((i) => i.id === 'palette')!.run();
    items.find((i) => i.id === 'install')!.run();
    expect(onCheck).toHaveBeenCalledOnce();
    expect(onPalette).toHaveBeenCalledOnce();
    expect(onInstall).toHaveBeenCalledOnce();
  });
});

function kebab(): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.id = 'btn-toolbar-overflow';
  btn.type = 'button';
  btn.setAttribute('aria-haspopup', 'menu');
  btn.setAttribute('aria-expanded', 'false');
  document.body.appendChild(btn);
  return btn;
}

const sampleItems = (run: () => void = () => {}): OverflowMenuItem[] => [
  { id: 'save-project-to-disk', label: 'Save to disk', run },
  { id: 'check', label: 'Check', run: () => {} },
  { id: 'prefs', label: 'Settings', run: () => {} },
];

describe('overflow menu surface', () => {
  test('opening builds a role=menu listing the items and marks the trigger expanded', () => {
    const trigger = kebab();
    openOverflowMenu(trigger, sampleItems());
    expect(isOverflowMenuOpen()).toBe(true);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const menu = document.querySelector('[role="menu"]');
    expect(menu).not.toBeNull();
    const labels = Array.from(menu!.querySelectorAll('[role="menuitem"]')).map((b) => b.textContent);
    expect(labels).toEqual(['Save to disk', 'Check', 'Settings']);
  });

  test('clicking a menu item runs its handler and closes the menu', () => {
    const trigger = kebab();
    const onSave = vi.fn();
    openOverflowMenu(trigger, sampleItems(onSave));
    const first = document.querySelector<HTMLButtonElement>('[role="menuitem"]')!;
    first.click();
    expect(onSave).toHaveBeenCalledOnce();
    expect(isOverflowMenuOpen()).toBe(false);
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  test('Escape closes the menu and returns focus to the kebab', () => {
    const trigger = kebab();
    openOverflowMenu(trigger, sampleItems());
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(isOverflowMenuOpen()).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });

  test('an outside pointerdown dismisses the menu', () => {
    const trigger = kebab();
    openOverflowMenu(trigger, sampleItems());
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(isOverflowMenuOpen()).toBe(false);
  });

  test('toggleOverflowMenu opens then closes on repeated activation', () => {
    const trigger = kebab();
    const getItems = (): OverflowMenuItem[] => sampleItems();
    toggleOverflowMenu(trigger, getItems);
    expect(isOverflowMenuOpen()).toBe(true);
    toggleOverflowMenu(trigger, getItems);
    expect(isOverflowMenuOpen()).toBe(false);
  });

  test('ArrowDown moves focus to the next menu item', () => {
    const trigger = kebab();
    openOverflowMenu(trigger, sampleItems());
    const items = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
    expect(document.activeElement).toBe(items[0]);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement).toBe(items[1]);
  });

  // End-to-end through the SAME createFloatingMenu engine buildOverflowItems' disabled flag targets
  // (issue #1407): a disabled item must render as a genuinely inert menu row, not merely a "disabled"
  // JS object field that the DOM ignores.
  test('a disabled item renders a native-disabled, non-activatable menu row', () => {
    const trigger = kebab();
    const onCheck = vi.fn();
    const items: OverflowMenuItem[] = [
      { id: 'save-project-to-disk', label: 'Save to disk', run: () => {} },
      { id: 'check', label: 'Check', run: onCheck, disabled: true },
    ];
    openOverflowMenu(trigger, items);

    const rows = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
    expect(rows[1].disabled).toBe(true);

    rows[1].click();
    expect(onCheck).not.toHaveBeenCalled();
    expect(isOverflowMenuOpen()).toBe(true); // a disabled row can't even dismiss the menu it sits in

    // Excluded from the roving-focus/keyboard-nav set (floatingMenu.ts's focusables() queries
    // `:not([disabled])`) — with only one other (enabled) row, ArrowDown has nowhere else to land.
    expect(document.activeElement).toBe(rows[0]);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement).toBe(rows[0]);
  });
});
