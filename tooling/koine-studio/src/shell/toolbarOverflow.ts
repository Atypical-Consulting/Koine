// The mobile top-toolbar overflow ("More" / ⋮) menu (#528).
//
// At phone width (≤ $bp-narrow) the _toolbar.scss media query hides the secondary toolbar actions
// (Save to disk, Check, Install, the ⌘K palette hint, Toggle theme, Settings) and reveals a single
// `#btn-toolbar-overflow` kebab. This module builds that kebab's menu from the SAME command registry
// the command palette uses (so handlers never drift) and renders it via the shared `createFloatingMenu`
// engine (#547) — a `<ul role="menu">` mounted on document.body, positioned at the trigger, dismissed on
// outside-pointerdown / Escape / Tab / action, with focus returned to the kebab.

import { createFloatingMenu, type Command } from '@atypical/koine-ui';

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
// any other. Built on the shared `createFloatingMenu` engine (#547); right-aligned under the kebab and
// closed WITHOUT refocusing it on item activation (the action it runs — open Settings / the palette,
// toggle theme, … — owns focus next; refocusing the kebab first would yank it back).
const overflowMenu = createFloatingMenu({
  menuClass: 'koi-overflow-menu',
  itemClass: 'koi-overflow-menu-item',
  ariaLabel: 'More actions',
});

/** True while the overflow menu is open. */
export function isOverflowMenuOpen(): boolean {
  return overflowMenu.isOpen;
}

/**
 * Tear down the menu and its global listeners. Idempotent. `refocus` returns focus to the kebab (the
 * normal dismiss path).
 */
export function closeOverflowMenu(refocus = true): void {
  overflowMenu.close(refocus);
}

/** Open the overflow menu at `trigger`, listing `items`. Closes any already-open menu first. */
export function openOverflowMenu(trigger: HTMLElement, items: OverflowMenuItem[]): void {
  // Right-align under the trigger so the menu hangs off the toolbar's right edge (where the kebab lives).
  overflowMenu.open({ trigger, items, align: 'right' });
}

/** Toggle the menu: open it (building items lazily) if closed, close it if already open. */
export function toggleOverflowMenu(trigger: HTMLElement, getItems: () => OverflowMenuItem[]): void {
  if (overflowMenu.isOpen) overflowMenu.close();
  else openOverflowMenu(trigger, getItems());
}
