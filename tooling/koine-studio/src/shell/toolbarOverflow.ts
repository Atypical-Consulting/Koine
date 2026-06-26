// The mobile top-toolbar overflow ("More" / ⋮) menu (#528).
//
// At phone width (≤ $bp-narrow) the _toolbar.scss media query hides the secondary toolbar actions
// (Save to disk, Check, Install, the ⌘K palette hint, Toggle theme, Settings) and reveals a single
// `#btn-toolbar-overflow` kebab. This module builds that kebab's menu from the SAME command registry
// the command palette uses (so handlers never drift) and renders a floating menu that mirrors the
// domain navigator's leaf `⋯` menu: a `<ul role="menu">` mounted on document.body, positioned at the
// trigger, dismissed on outside-pointerdown / Escape / Tab / action, with focus returned to the kebab.

import { el } from '@/shared/el';
import type { Command } from '@/shared/palette';

export interface OverflowMenuItem {
  /** Stable id — the source command id, or a synthetic id ('install' / 'palette'). */
  id: string;
  /** Visible (and accessible) menu label. */
  label: string;
  /** Activate the action. */
  run: () => void;
}

export interface OverflowItemDeps {
  /** The live command registry (ide.tsx `getCommands()`) — the menu reuses these handlers. */
  commands: Command[];
  /** Open the command palette (the ⌘K affordance the menu replaces on mobile). */
  openPalette: () => void;
  /** True only while the PWA install affordance is currently revealed (#442 gating). */
  installAvailable: boolean;
  /** Trigger the PWA install prompt (reuses the `#btn-install` handler). */
  install: () => void;
}

// The secondary toolbar actions that the narrow-width media query collapses, each mapped to the
// command id whose handler it reuses. Order mirrors how the issue lists the clipped controls.
// `generate-project` is intentionally absent: Generate stays inline on mobile, so duplicating it
// here would offer the same action twice.
const SAVE_CMD = 'save-project-to-disk';
const CHECK_CMD = 'check';
const THEME_CMD = 'toggle-theme';
const PREFS_CMD = 'prefs';

/**
 * Build the overflow menu's items from the command registry + the install/palette thunks. Save to disk
 * appears only when the platform exposes its command (it's gated on `canSaveProjects`, same as the inline
 * button); Install appears only when its affordance is currently revealed.
 */
export function buildOverflowItems(deps: OverflowItemDeps): OverflowMenuItem[] {
  const byId = new Map(deps.commands.map((c) => [c.id, c]));
  const fromCmd = (id: string, label: string): OverflowMenuItem | null => {
    const cmd = byId.get(id);
    return cmd ? { id, label, run: () => cmd.run() } : null;
  };
  const items: Array<OverflowMenuItem | null> = [
    fromCmd(SAVE_CMD, 'Save to disk'),
    fromCmd(CHECK_CMD, 'Check'),
    deps.installAvailable ? { id: 'install', label: 'Install', run: deps.install } : null,
    { id: 'palette', label: 'Command palette', run: deps.openPalette },
    fromCmd(THEME_CMD, 'Toggle theme'),
    fromCmd(PREFS_CMD, 'Settings'),
  ];
  return items.filter((x): x is OverflowMenuItem => x !== null);
}

// The single floating menu (mounted to document.body and reused), module-scoped so opening one closes
// any other — mirroring the domain navigator's leaf menu.
let menuEl: HTMLElement | null = null;
let menuTrigger: HTMLElement | null = null;

/** True while the overflow menu is open. */
export function isOverflowMenuOpen(): boolean {
  return menuEl !== null;
}

/**
 * Tear down the menu and its global listeners. Idempotent. `refocus` returns focus to the kebab (the
 * normal dismiss path); an item activation passes `false` because the action it runs (open Settings,
 * open the palette, …) owns focus next — refocusing the kebab first would steal it back.
 */
export function closeOverflowMenu(refocus = true): void {
  if (!menuEl) return;
  menuEl.remove();
  menuEl = null;
  document.removeEventListener('pointerdown', onPointerDown, true);
  document.removeEventListener('keydown', onKeydown, true);
  const trigger = menuTrigger;
  menuTrigger = null;
  if (trigger) {
    trigger.setAttribute('aria-expanded', 'false');
    if (refocus && trigger.isConnected) trigger.focus();
  }
}

function menuItems(): HTMLElement[] {
  return menuEl ? Array.from(menuEl.querySelectorAll<HTMLElement>('[role="menuitem"]')) : [];
}

function onPointerDown(ev: PointerEvent): void {
  if (menuEl && !menuEl.contains(ev.target as Node) && ev.target !== menuTrigger) closeOverflowMenu();
}

function onKeydown(ev: KeyboardEvent): void {
  if (!menuEl) return;
  const items = menuItems();
  const i = items.indexOf(document.activeElement as HTMLElement);
  if (ev.key === 'Escape' || ev.key === 'Tab') {
    ev.preventDefault();
    closeOverflowMenu();
  } else if (ev.key === 'ArrowDown') {
    ev.preventDefault();
    items[Math.min(items.length - 1, i + 1)]?.focus();
  } else if (ev.key === 'ArrowUp') {
    ev.preventDefault();
    items[Math.max(0, i - 1)]?.focus();
  } else if (ev.key === 'Home') {
    ev.preventDefault();
    items[0]?.focus();
  } else if (ev.key === 'End') {
    ev.preventDefault();
    items[items.length - 1]?.focus();
  }
}

/** Open the overflow menu at `trigger`, listing `items`. Closes any already-open menu first. */
export function openOverflowMenu(trigger: HTMLElement, items: OverflowMenuItem[]): void {
  closeOverflowMenu(false);

  const menu = el('ul', { class: 'koi-overflow-menu', attrs: { role: 'menu', 'aria-label': 'More actions' } });
  for (const it of items) {
    const btn = el('button', {
      class: 'koi-overflow-menu-item',
      text: it.label,
      attrs: { type: 'button', role: 'menuitem' },
      on: {
        click: () => {
          // Close WITHOUT refocusing the kebab: the action (open Settings / palette, toggle theme, …)
          // takes focus next; refocusing the trigger first would yank it back.
          closeOverflowMenu(false);
          it.run();
        },
      },
    });
    menu.appendChild(el('li', { attrs: { role: 'none' } }, btn));
  }

  // Right-align under the trigger so the menu hangs off the toolbar's right edge (where the kebab lives).
  const rect = trigger.getBoundingClientRect();
  menu.style.top = `${rect.bottom}px`;
  menu.style.right = `${Math.max(0, window.innerWidth - rect.right)}px`;

  menuTrigger = trigger;
  trigger.setAttribute('aria-expanded', 'true');
  document.body.appendChild(menu);
  menuEl = menu;
  menuItems()[0]?.focus();
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('keydown', onKeydown, true);
}

/** Toggle the menu: open it (building items lazily) if closed, close it if already open. */
export function toggleOverflowMenu(trigger: HTMLElement, getItems: () => OverflowMenuItem[]): void {
  if (isOverflowMenuOpen()) {
    closeOverflowMenu();
    return;
  }
  openOverflowMenu(trigger, getItems());
}
