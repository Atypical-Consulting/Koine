import { describe, expect, test, vi } from 'vitest';
import { handleTreeKeydown, type RovingTreeNav } from '@/shell/rovingTreeNav';

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
});
