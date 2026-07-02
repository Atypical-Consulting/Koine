// A shared floating "popup menu" engine for Koine Studio (#547).
//
// Koine Studio grew three hand-maintained copies of the same pattern — the toolbar overflow ("⋮ More")
// menu (#528), the domain navigator's per-leaf `⋯` menu, and the explorer context menu — and they had
// begun to drift (the toolbar copy gained Home/End nav and a contains()-based dismissal guard the others
// lacked). This module is the single engine all three now consume: build a `<ul role="menu">` of items,
// position it (anchored under a trigger, or at an explicit viewport point for a context menu), mount it
// on document.body, dismiss on outside-pointerdown / Tab / Escape, run keyboard nav (Arrow/Home/End),
// toggle the trigger's aria-expanded, and return focus to the trigger on dismiss.
//
// Escape routes through overlay.ts's Esc-stack (registerOverlay) rather than a bespoke per-menu keydown,
// so a single Escape dismisses only the top-most layer (the exact bug overlay.ts was written to prevent)
// even when a modal is also open.

import { el } from './el';
import { registerOverlay } from './overlay';

/** One actionable row in a floating menu. */
export interface FloatingMenuItem {
  /** Stable id (the source command id, or a synthetic one). */
  id: string;
  /** Visible (and accessible) label. */
  label: string;
  /** Activate the action. */
  run: () => void;
  /** Render disabled — non-focusable, non-activatable. */
  disabled?: boolean;
}

/** Per-menu configuration, fixed when the controller is created. */
export interface FloatingMenuConfig {
  /** Class on the `<ul role="menu">` surface (e.g. 'koi-overflow-menu'), so each call site keeps its chrome. */
  menuClass: string;
  /** Class on each `<button role="menuitem">` (e.g. 'koi-overflow-menu-item'). */
  itemClass: string;
  /** Accessible name for the menu; omitted → no aria-label (the leaf menu has none). */
  ariaLabel?: string;
  /**
   * Toggle `aria-expanded` on the trigger while the menu is open. Default true (the toolbar/leaf
   * triggers carry aria-haspopup + aria-expanded); context menus whose trigger is a treeitem set this
   * false so the menu does not clobber the treeitem's own expansion state.
   */
  markTriggerExpanded?: boolean;
  /**
   * Skip dismissal when an outside-pointerdown lands inside the trigger's subtree — so a tap on the
   * trigger's inner icon toggles rather than re-opens. Default true. A context menu whose trigger is a
   * large container (a treeitem) sets this false, dismissing on any click outside the menu itself.
   */
  guardTriggerSubtree?: boolean;
  /**
   * Return focus to the trigger after an item is ACTIVATED. Default false — the action being run
   * (open Settings, reveal a file, …) owns focus next, so refocusing the trigger first would steal it
   * back. The explorer context menu sets this true (it refocuses the treeitem on every close path).
   */
  refocusTriggerOnActivate?: boolean;
  /** Run after the menu closes by ANY path (outside-click, Escape, Tab, item activation, programmatic). */
  onClose?: () => void;
}

/** Per-open inputs: the items, the focus-return trigger, and where to position. */
export interface FloatingMenuOpenOptions {
  /** Items to render (built lazily by the caller). */
  items: FloatingMenuItem[];
  /** Element to toggle aria-expanded on and return focus to on dismiss. May be null. */
  trigger: HTMLElement | null;
  /** Explicit viewport point to position at (a context menu at the cursor). When omitted, the menu is
   *  positioned from `trigger.getBoundingClientRect()`. */
  at?: { x: number; y: number };
  /** Horizontal alignment when positioning from the trigger rect. 'left' (default) hangs the menu's
   *  left edge under the trigger's left; 'right' hangs its right edge under the trigger's right. */
  align?: 'left' | 'right';
}

/** Imperative handle for a floating menu. */
export interface FloatingMenu {
  /** Open the menu (closing it first if already open). */
  open(opts: FloatingMenuOpenOptions): void;
  /** Close the menu. `refocus` returns focus to the trigger (default true; the dismiss path). */
  close(refocus?: boolean): void;
  /** Open if closed, close if open. */
  toggle(opts: FloatingMenuOpenOptions): void;
  /** True while the menu is open. */
  readonly isOpen: boolean;
}

export function createFloatingMenu(config: FloatingMenuConfig): FloatingMenu {
  const markExpanded = config.markTriggerExpanded ?? true;
  const guardSubtree = config.guardTriggerSubtree ?? true;
  const refocusOnActivate = config.refocusTriggerOnActivate ?? false;

  let menuEl: HTMLElement | null = null;
  let menuTrigger: HTMLElement | null = null;
  let unregisterOverlay: (() => void) | null = null;

  // The focusable (enabled) menu items, in DOM order — the valid roving-focus stops.
  function focusables(): HTMLElement[] {
    return menuEl
      ? Array.from(menuEl.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])'))
      : [];
  }

  function onPointerDown(ev: PointerEvent): void {
    if (!menuEl) return;
    const target = ev.target as Node;
    if (menuEl.contains(target)) return; // a click inside the menu is not a dismissal
    if (guardSubtree && menuTrigger && menuTrigger.contains(target)) return; // tap on the trigger's own subtree
    close();
  }

  function onKeydown(ev: KeyboardEvent): void {
    if (!menuEl) return;
    const items = focusables();
    const i = items.indexOf(document.activeElement as HTMLElement);
    // Escape is intentionally NOT handled here — it routes through overlay.ts's Esc-stack so a single
    // Escape closes only the top-most layer.
    if (ev.key === 'Tab') {
      ev.preventDefault();
      close();
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

  function close(refocus = true): void {
    if (!menuEl) return;
    menuEl.remove();
    menuEl = null;
    document.removeEventListener('pointerdown', onPointerDown, true);
    document.removeEventListener('keydown', onKeydown, true);
    unregisterOverlay?.();
    unregisterOverlay = null;
    const trigger = menuTrigger;
    menuTrigger = null;
    if (trigger) {
      if (markExpanded) trigger.setAttribute('aria-expanded', 'false');
      if (refocus && trigger.isConnected) trigger.focus();
    }
    config.onClose?.();
  }

  function open(opts: FloatingMenuOpenOptions): void {
    close(false); // tear down any prior instance without bouncing focus back to its trigger

    const menu = el('ul', {
      class: config.menuClass,
      attrs: { role: 'menu', 'aria-label': config.ariaLabel ?? null },
    });
    for (const it of opts.items) {
      const btn = el('button', {
        class: config.itemClass,
        text: it.label,
        attrs: { type: 'button', role: 'menuitem', disabled: it.disabled ?? false },
        on: it.disabled
          ? {}
          : {
              click: () => {
                close(refocusOnActivate);
                it.run();
              },
            },
      });
      menu.appendChild(el('li', { attrs: { role: 'none' } }, btn));
    }

    // Position: at an explicit point (context menu) or anchored to the trigger's rect.
    if (opts.at) {
      menu.style.left = `${opts.at.x}px`;
      menu.style.top = `${opts.at.y}px`;
    } else if (opts.trigger) {
      const rect = opts.trigger.getBoundingClientRect();
      menu.style.top = `${rect.bottom}px`;
      if (opts.align === 'right') {
        menu.style.right = `${Math.max(0, window.innerWidth - rect.right)}px`;
      } else {
        menu.style.left = `${rect.left}px`;
      }
    }

    menuTrigger = opts.trigger;
    if (menuTrigger && markExpanded) menuTrigger.setAttribute('aria-expanded', 'true');
    document.body.appendChild(menu);
    menuEl = menu;
    focusables()[0]?.focus();
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeydown, true);
    // Route Escape through the shared Esc-stack: the top-most registered overlay closes on Escape.
    unregisterOverlay = registerOverlay(() => close());
  }

  function toggle(opts: FloatingMenuOpenOptions): void {
    if (menuEl) close();
    else open(opts);
  }

  return {
    open,
    close,
    toggle,
    get isOpen() {
      return menuEl !== null;
    },
  };
}
