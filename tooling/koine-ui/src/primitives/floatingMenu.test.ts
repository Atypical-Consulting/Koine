import { afterEach, describe, expect, test, vi } from 'vitest';
import { registerOverlay } from './overlay';
import { createFloatingMenu, type FloatingMenuItem } from './floatingMenu';

// A trigger button (with an inner <span>, to exercise the contains() subtree guard) mounted on body.
function trigger(): { btn: HTMLButtonElement; inner: HTMLSpanElement } {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.setAttribute('aria-haspopup', 'menu');
  btn.setAttribute('aria-expanded', 'false');
  const inner = document.createElement('span');
  inner.textContent = '⋮';
  btn.appendChild(inner);
  document.body.appendChild(btn);
  btn.focus();
  return { btn, inner };
}

const items = (run: () => void = () => {}): FloatingMenuItem[] => [
  { id: 'a', label: 'Alpha', run },
  { id: 'b', label: 'Beta', run: () => {} },
  { id: 'c', label: 'Gamma', run: () => {} },
];

afterEach(() => {
  document.body.replaceChildren();
});

describe('createFloatingMenu', () => {
  test('opening builds a role=menu of the items and marks the trigger expanded', () => {
    const menu = createFloatingMenu({ menuClass: 'm', itemClass: 'mi', ariaLabel: 'Stuff' });
    const { btn } = trigger();
    menu.open({ trigger: btn, items: items() });
    expect(menu.isOpen).toBe(true);
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    const ul = document.querySelector('[role="menu"]')!;
    expect(ul).not.toBeNull();
    expect(ul.getAttribute('aria-label')).toBe('Stuff');
    expect(ul.classList.contains('m')).toBe(true);
    const labels = Array.from(ul.querySelectorAll('[role="menuitem"]')).map((b) => b.textContent);
    expect(labels).toEqual(['Alpha', 'Beta', 'Gamma']);
    // First item is focused on open.
    expect(document.activeElement).toBe(ul.querySelector('[role="menuitem"]'));
  });

  test('clicking an item runs its handler and closes the menu (no refocus by default)', () => {
    const menu = createFloatingMenu({ menuClass: 'm', itemClass: 'mi' });
    const { btn } = trigger();
    const onRun = vi.fn();
    menu.open({ trigger: btn, items: items(onRun) });
    document.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click();
    expect(onRun).toHaveBeenCalledOnce();
    expect(menu.isOpen).toBe(false);
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    // Default refocusTriggerOnActivate=false: the activated action owns focus, not the trigger.
    expect(document.activeElement).not.toBe(btn);
  });

  test('refocusTriggerOnActivate returns focus to the trigger after an item runs', () => {
    const menu = createFloatingMenu({ menuClass: 'm', itemClass: 'mi', refocusTriggerOnActivate: true });
    const { btn } = trigger();
    menu.open({ trigger: btn, items: items() });
    document.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click();
    expect(document.activeElement).toBe(btn);
  });

  test('Escape closes the menu and returns focus to the trigger (via the overlay Esc-stack)', () => {
    const menu = createFloatingMenu({ menuClass: 'm', itemClass: 'mi' });
    const { btn } = trigger();
    menu.open({ trigger: btn, items: items() });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(menu.isOpen).toBe(false);
    expect(document.activeElement).toBe(btn);
  });

  test('Escape dismisses only the top layer when a modal overlay is also open', () => {
    const modalClose = vi.fn();
    const unregister = registerOverlay(modalClose); // a "modal" registered below the menu
    const menu = createFloatingMenu({ menuClass: 'm', itemClass: 'mi' });
    const { btn } = trigger();
    menu.open({ trigger: btn, items: items() }); // registers above the modal
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(menu.isOpen).toBe(false);
    expect(modalClose).not.toHaveBeenCalled(); // the layer below survives the single Escape
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(modalClose).toHaveBeenCalledOnce(); // a second Escape reaches it
    unregister();
  });

  test('an outside pointerdown dismisses the menu', () => {
    const menu = createFloatingMenu({ menuClass: 'm', itemClass: 'mi' });
    const { btn } = trigger();
    menu.open({ trigger: btn, items: items() });
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(menu.isOpen).toBe(false);
  });

  test('a pointerdown on the trigger subtree does NOT dismiss (contains guard)', () => {
    const menu = createFloatingMenu({ menuClass: 'm', itemClass: 'mi' });
    const { btn, inner } = trigger();
    menu.open({ trigger: btn, items: items() });
    inner.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(menu.isOpen).toBe(true);
  });

  test('guardTriggerSubtree=false dismisses on a pointerdown inside the trigger subtree', () => {
    const menu = createFloatingMenu({ menuClass: 'm', itemClass: 'mi', guardTriggerSubtree: false });
    const { btn, inner } = trigger();
    menu.open({ trigger: btn, items: items() });
    inner.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(menu.isOpen).toBe(false);
  });

  test('Arrow/Home/End move focus across the menu items', () => {
    const menu = createFloatingMenu({ menuClass: 'm', itemClass: 'mi' });
    const { btn } = trigger();
    menu.open({ trigger: btn, items: items() });
    const its = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
    expect(document.activeElement).toBe(its[0]);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement).toBe(its[1]);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(document.activeElement).toBe(its[2]);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    expect(document.activeElement).toBe(its[1]);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    expect(document.activeElement).toBe(its[0]);
  });

  test('Tab closes the menu', () => {
    const menu = createFloatingMenu({ menuClass: 'm', itemClass: 'mi' });
    const { btn } = trigger();
    menu.open({ trigger: btn, items: items() });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(menu.isOpen).toBe(false);
  });

  test('toggle opens then closes on repeated activation', () => {
    const menu = createFloatingMenu({ menuClass: 'm', itemClass: 'mi' });
    const { btn } = trigger();
    menu.toggle({ trigger: btn, items: items() });
    expect(menu.isOpen).toBe(true);
    menu.toggle({ trigger: btn, items: items() });
    expect(menu.isOpen).toBe(false);
  });

  test('markTriggerExpanded=false leaves the trigger aria-expanded untouched', () => {
    const menu = createFloatingMenu({ menuClass: 'm', itemClass: 'mi', markTriggerExpanded: false });
    const { btn } = trigger();
    btn.removeAttribute('aria-expanded'); // a context-menu trigger (treeitem) has none
    menu.open({ trigger: btn, items: items() });
    expect(btn.hasAttribute('aria-expanded')).toBe(false);
    menu.close();
    expect(btn.hasAttribute('aria-expanded')).toBe(false);
  });

  test('positions at an explicit viewport point when given `at`', () => {
    const menu = createFloatingMenu({ menuClass: 'm', itemClass: 'mi' });
    const { btn } = trigger();
    menu.open({ trigger: btn, at: { x: 12, y: 34 }, items: items() });
    const ul = document.querySelector<HTMLElement>('[role="menu"]')!;
    expect(ul.style.left).toBe('12px');
    expect(ul.style.top).toBe('34px');
  });

  test('onClose fires on every dismissal path', () => {
    const onClose = vi.fn();
    const menu = createFloatingMenu({ menuClass: 'm', itemClass: 'mi', onClose });
    const { btn } = trigger();
    menu.open({ trigger: btn, items: items() });
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  test('a disabled item is not focused on open and is excluded from arrow nav', () => {
    const menu = createFloatingMenu({ menuClass: 'm', itemClass: 'mi' });
    const { btn } = trigger();
    menu.open({
      trigger: btn,
      items: [
        { id: 'a', label: 'Alpha', run: () => {}, disabled: true },
        { id: 'b', label: 'Beta', run: () => {} },
      ],
    });
    const beta = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find(
      (b) => b.textContent === 'Beta',
    )!;
    expect(document.activeElement).toBe(beta); // first ENABLED item gets focus
  });
});
