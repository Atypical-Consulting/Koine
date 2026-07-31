import { afterEach, describe, expect, test, vi } from 'vitest';
import { createRovingTabIndex, handleTreeKeydown, type RovingTreeNav } from '@/shell/rovingTreeNav';

afterEach(() => {
  document.body.innerHTML = '';
});

// A fake, DOM-free nav over a plain array — exactly the "give me the ordered visible items" seam the
// three Studio tree panels adapt onto. `focusIndex` records the move and updates the active index so a
// sequence of keydowns walks as it would in a live panel.
function makeNav(overrides: Partial<RovingTreeNav<string>> = {}): {
  nav: RovingTreeNav<string>;
  focus: number[];
  expandArg: number[];
  collapseArg: number[];
  activateArg: number[];
  setActive: (i: number) => void;
} {
  const items = ['a', 'b', 'c', 'd'];
  let active = 0;
  const focus: number[] = [];
  const expandArg: number[] = [];
  const collapseArg: number[] = [];
  const activateArg: number[] = [];
  const nav: RovingTreeNav<string> = {
    items: () => items,
    activeIndex: () => active,
    focusIndex: (i) => {
      focus.push(i);
      active = i;
    },
    expand: (i) => {
      expandArg.push(i);
      return true;
    },
    collapse: (i) => {
      collapseArg.push(i);
      return true;
    },
    activate: (i) => {
      activateArg.push(i);
    },
    ...overrides,
  };
  return { nav, focus, expandArg, collapseArg, activateArg, setActive: (i) => (active = i) };
}

// Build a keydown event with a spied preventDefault.
function keydown(key: string): { ev: KeyboardEvent; prevented: () => boolean } {
  const ev = new KeyboardEvent('keydown', { key });
  const spy = vi.spyOn(ev, 'preventDefault');
  return { ev, prevented: () => spy.mock.calls.length > 0 };
}

describe('handleTreeKeydown', () => {
  test('ArrowDown moves focus to the next item and prevents default', () => {
    const h = makeNav();
    const { ev, prevented } = keydown('ArrowDown');
    handleTreeKeydown(h.nav, ev);
    expect(h.focus).toEqual([1]);
    expect(prevented()).toBe(true);
  });

  test('ArrowUp moves focus to the previous item and prevents default', () => {
    const h = makeNav();
    h.setActive(2);
    const { ev, prevented } = keydown('ArrowUp');
    handleTreeKeydown(h.nav, ev);
    expect(h.focus).toEqual([1]);
    expect(prevented()).toBe(true);
  });

  test('ArrowDown at the last item does not wrap (stays at last) but still prevents default', () => {
    const h = makeNav();
    h.setActive(3); // last
    const { ev, prevented } = keydown('ArrowDown');
    handleTreeKeydown(h.nav, ev);
    expect(h.focus).toEqual([3]);
    expect(prevented()).toBe(true);
  });

  test('ArrowUp at the first item does not wrap (stays at 0)', () => {
    const h = makeNav();
    h.setActive(0);
    const { ev, prevented } = keydown('ArrowUp');
    handleTreeKeydown(h.nav, ev);
    expect(h.focus).toEqual([0]);
    expect(prevented()).toBe(true);
  });

  test('Home jumps to the first item, End jumps to the last', () => {
    const h = makeNav();
    h.setActive(2);
    handleTreeKeydown(h.nav, keydown('Home').ev);
    expect(h.focus).toEqual([0]);
    handleTreeKeydown(h.nav, keydown('End').ev);
    expect(h.focus).toEqual([0, 3]);
  });

  test('Home/End prevent default', () => {
    const h = makeNav();
    const home = keydown('Home');
    handleTreeKeydown(h.nav, home.ev);
    expect(home.prevented()).toBe(true);
    const end = keydown('End');
    handleTreeKeydown(h.nav, end.ev);
    expect(end.prevented()).toBe(true);
  });

  test('Enter and Space both call activate with the active index and prevent default', () => {
    const h = makeNav();
    h.setActive(2);
    const enter = keydown('Enter');
    handleTreeKeydown(h.nav, enter.ev);
    const space = keydown(' ');
    handleTreeKeydown(h.nav, space.ev);
    expect(h.activateArg).toEqual([2, 2]);
    expect(enter.prevented()).toBe(true);
    expect(space.prevented()).toBe(true);
  });

  test('ArrowRight calls expand and ArrowLeft calls collapse with the active index', () => {
    const h = makeNav();
    h.setActive(1);
    handleTreeKeydown(h.nav, keydown('ArrowRight').ev);
    handleTreeKeydown(h.nav, keydown('ArrowLeft').ev);
    expect(h.expandArg).toEqual([1]);
    expect(h.collapseArg).toEqual([1]);
  });

  test('expand returning false leaves the key to the browser (no preventDefault)', () => {
    const h = makeNav({ expand: () => false });
    const { ev, prevented } = keydown('ArrowRight');
    handleTreeKeydown(h.nav, ev);
    expect(prevented()).toBe(false);
  });

  test('expand returning true prevents default', () => {
    const h = makeNav({ expand: () => true });
    const { ev, prevented } = keydown('ArrowRight');
    handleTreeKeydown(h.nav, ev);
    expect(prevented()).toBe(true);
  });

  test('activate returning false leaves the key to the browser (native activation)', () => {
    const h = makeNav({ activate: () => false });
    const { ev, prevented } = keydown('Enter');
    handleTreeKeydown(h.nav, ev);
    expect(prevented()).toBe(false);
  });

  test('when expand/collapse are absent, ArrowRight/ArrowLeft are no-ops (no preventDefault)', () => {
    const h = makeNav({ expand: undefined, collapse: undefined });
    const right = keydown('ArrowRight');
    handleTreeKeydown(h.nav, right.ev);
    const left = keydown('ArrowLeft');
    handleTreeKeydown(h.nav, left.ev);
    expect(right.prevented()).toBe(false);
    expect(left.prevented()).toBe(false);
    expect(h.focus).toEqual([]);
  });

  test('when activate is absent, Enter/Space are no-ops (no preventDefault)', () => {
    const h = makeNav({ activate: undefined });
    const enter = keydown('Enter');
    handleTreeKeydown(h.nav, enter.ev);
    expect(enter.prevented()).toBe(false);
  });

  test('supportsHomeEnd:false leaves Home/End to the browser', () => {
    const h = makeNav({ supportsHomeEnd: false });
    h.setActive(2);
    const home = keydown('Home');
    handleTreeKeydown(h.nav, home.ev);
    const end = keydown('End');
    handleTreeKeydown(h.nav, end.ev);
    expect(home.prevented()).toBe(false);
    expect(end.prevented()).toBe(false);
    expect(h.focus).toEqual([]);
  });

  test('supportsSpaceActivate:false leaves Space to the browser but keeps Enter activation', () => {
    const h = makeNav({ supportsSpaceActivate: false });
    h.setActive(1);
    const space = keydown(' ');
    handleTreeKeydown(h.nav, space.ev);
    expect(space.prevented()).toBe(false);
    expect(h.activateArg).toEqual([]);
    const enter = keydown('Enter');
    handleTreeKeydown(h.nav, enter.ev);
    expect(enter.prevented()).toBe(true);
    expect(h.activateArg).toEqual([1]);
  });

  test('an unhandled key (Backspace) is ignored — no move, no preventDefault', () => {
    const h = makeNav();
    const { ev, prevented } = keydown('Backspace');
    handleTreeKeydown(h.nav, ev);
    expect(h.focus).toEqual([]);
    expect(prevented()).toBe(false);
  });

  test('an empty tree is a no-op for every key (no preventDefault)', () => {
    const h = makeNav({ items: () => [], activeIndex: () => -1 });
    for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' ', 'ArrowRight', 'ArrowLeft']) {
      const { ev, prevented } = keydown(key);
      handleTreeKeydown(h.nav, ev);
      expect(prevented()).toBe(false);
    }
    expect(h.focus).toEqual([]);
  });

  test('with no active item (-1), ArrowDown enters at the first item', () => {
    const h = makeNav({ activeIndex: () => -1 });
    const { ev } = keydown('ArrowDown');
    handleTreeKeydown(h.nav, ev);
    expect(h.focus).toEqual([0]);
  });

  test('with no active item (-1), structural/activation keys never index into items() (no -1 deref)', () => {
    const h = makeNav({ activeIndex: () => -1 });
    for (const key of ['ArrowRight', 'ArrowLeft', 'Enter', ' ']) {
      const { ev, prevented } = keydown(key);
      handleTreeKeydown(h.nav, ev);
      expect(prevented()).toBe(false);
    }
    expect(h.expandArg).toEqual([]);
    expect(h.collapseArg).toEqual([]);
    expect(h.activateArg).toEqual([]);
  });
});

// The DOM-facing half of the roving-tabindex glue (#1365): seeding the lone tab stop and resolving an
// event/the current focus to its treeitem — previously hand-rolled, near-identically, in both
// `DomainNavigator.tsx` and `generatedFileTree.ts`. `isVisible` and `nestedButtonSelector` are the two
// real differences between those call sites (a collapse-aware visible/all split; nested `<button>`s that
// must leave the tab order) — both are opt-in so a caller that needs neither (like domainNavigator's own
// "no collapse" trees) pays for neither.
describe('createRovingTabIndex', () => {
  function buildTree(spec: Array<{ nestedButton?: boolean; hidden?: boolean }>): {
    tree: HTMLElement;
    items: HTMLElement[];
  } {
    const tree = document.createElement('ul');
    tree.setAttribute('role', 'tree');
    const items = spec.map((s) => {
      const li = document.createElement('li');
      li.setAttribute('role', 'treeitem');
      if (s.hidden) li.dataset.hidden = 'true';
      if (s.nestedButton) {
        const btn = document.createElement('button');
        btn.textContent = 'more';
        li.appendChild(btn);
      }
      tree.appendChild(li);
      return li;
    });
    document.body.appendChild(tree);
    return { tree, items };
  }

  const hiddenFilter = (el: HTMLElement) => el.dataset.hidden !== 'true';

  describe('setRovingItem', () => {
    test('seeds the first treeitem as the tab stop when no active item is given', () => {
      const { tree, items } = buildTree([{}, {}, {}]);
      createRovingTabIndex(tree).setRovingItem(null);
      expect(items.map((i) => i.tabIndex)).toEqual([0, -1, -1]);
    });

    test('seeds the given active item as the tab stop and clears every other item', () => {
      const { tree, items } = buildTree([{}, {}, {}]);
      createRovingTabIndex(tree).setRovingItem(items[1]);
      expect(items.map((i) => i.tabIndex)).toEqual([-1, 0, -1]);
    });

    test('falls back to the first item when the given active item is not in the tree', () => {
      const { tree, items } = buildTree([{}, {}, {}]);
      const stray = document.createElement('li');
      createRovingTabIndex(tree).setRovingItem(stray);
      expect(items.map((i) => i.tabIndex)).toEqual([0, -1, -1]);
    });

    test('with an isVisible filter, a filtered-out item is never made the tab stop even when passed as active', () => {
      const { tree, items } = buildTree([{}, { hidden: true }, {}]);
      createRovingTabIndex(tree, { isVisible: hiddenFilter }).setRovingItem(items[1]);
      expect(items.map((i) => i.tabIndex)).toEqual([0, -1, -1]);
    });

    test('with an isVisible filter, seeding falls back to the first VISIBLE item, skipping a filtered-out first item', () => {
      const { tree, items } = buildTree([{ hidden: true }, {}, {}]);
      createRovingTabIndex(tree, { isVisible: hiddenFilter }).setRovingItem(null);
      expect(items.map((i) => i.tabIndex)).toEqual([-1, 0, -1]);
    });

    test('with a nestedButtonSelector, matching nested controls are pulled out of the tab order before seeding', () => {
      const { tree, items } = buildTree([{ nestedButton: true }, {}]);
      const btn = items[0].querySelector<HTMLElement>('button')!;
      btn.tabIndex = 0;
      createRovingTabIndex(tree, { nestedButtonSelector: 'button' }).setRovingItem(null);
      expect(btn.tabIndex).toBe(-1);
      expect(items.map((i) => i.tabIndex)).toEqual([0, -1]);
    });

    test('without a nestedButtonSelector, nested controls are left untouched', () => {
      const { tree, items } = buildTree([{ nestedButton: true }, {}]);
      const btn = items[0].querySelector<HTMLElement>('button')!;
      btn.tabIndex = 0;
      createRovingTabIndex(tree).setRovingItem(null);
      expect(btn.tabIndex).toBe(0);
    });
  });

  describe('focusItem', () => {
    test('moves the tab stop to the item and focuses it', () => {
      const { tree, items } = buildTree([{}, {}]);
      createRovingTabIndex(tree).focusItem(items[1]);
      expect(items.map((i) => i.tabIndex)).toEqual([-1, 0]);
      expect(document.activeElement).toBe(items[1]);
    });
  });

  describe('currentTreeItem', () => {
    test('resolves to the closest treeitem ancestor of the event target', () => {
      const { tree, items } = buildTree([{}, {}]);
      const child = document.createElement('span');
      items[0].appendChild(child);
      const helper = createRovingTabIndex(tree);
      const ev = new MouseEvent('click');
      Object.defineProperty(ev, 'target', { value: child });
      expect(helper.currentTreeItem(ev)).toBe(items[0]);
    });

    test('falls back to the currently-focused element when the event target has no treeitem ancestor', () => {
      const { tree, items } = buildTree([{}, {}]);
      const outside = document.createElement('div');
      document.body.appendChild(outside);
      items[1].tabIndex = 0;
      items[1].focus();
      const helper = createRovingTabIndex(tree);
      const ev = new MouseEvent('click');
      Object.defineProperty(ev, 'target', { value: outside });
      expect(helper.currentTreeItem(ev)).toBe(items[1]);
    });

    test('resolves via the target\'s parentElement when the target is a non-Element node (e.g. a text node)', () => {
      const { tree, items } = buildTree([{}, {}]);
      const textNode = document.createTextNode('label');
      items[0].appendChild(textNode);
      const helper = createRovingTabIndex(tree);
      const ev = new MouseEvent('click');
      Object.defineProperty(ev, 'target', { value: textNode });
      expect(helper.currentTreeItem(ev)).toBe(items[0]);
    });

    test('returns null when nothing matches (no treeitem ancestor, nothing focused)', () => {
      const { tree } = buildTree([{}, {}]);
      const outside = document.createElement('div');
      document.body.appendChild(outside);
      const helper = createRovingTabIndex(tree);
      const ev = new MouseEvent('click');
      Object.defineProperty(ev, 'target', { value: outside });
      expect(helper.currentTreeItem(ev)).toBeNull();
    });
  });

  describe('visibleTreeItems', () => {
    test('returns every treeitem in DOM order when no isVisible filter is given', () => {
      const { tree, items } = buildTree([{}, {}, {}]);
      expect(createRovingTabIndex(tree).visibleTreeItems()).toEqual(items);
    });

    test('returns only the items the isVisible filter admits, in DOM order', () => {
      const { tree, items } = buildTree([{}, { hidden: true }, {}]);
      expect(createRovingTabIndex(tree, { isVisible: hiddenFilter }).visibleTreeItems()).toEqual([
        items[0],
        items[2],
      ]);
    });
  });
});
