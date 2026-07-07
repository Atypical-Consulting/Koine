// Unit tests for the Spotlight launcher's pure keyboard reducer (issue #1143, task 7). Ported from the
// "Keyboard" section of design/design_handoff_git_spotlight_logos/README.md §2 and the prototype's
// `document.addEventListener("keydown", ...)` handler in
// `Koine Launcher - Spotlight.html`. Every case here is asserted against `handleKey` alone — no DOM,
// no LauncherPanel — `LauncherPanel.test.tsx` covers the wiring separately.
import { describe, expect, test } from 'vitest';
import { handleKey, type LauncherKeyState } from '@/launcher/keys';

function makeState(over: Partial<LauncherKeyState> = {}): LauncherKeyState {
  return {
    query: '',
    selectedIndex: 0,
    resultCount: 3,
    menuOpen: false,
    menuIndex: 0,
    menuCount: 3,
    selectedTitle: 'Order',
    modePrefix: '',
    ...over,
  };
}

/** A minimal `KeyboardEvent`-shaped literal — `handleKey` only reads these five fields, so tests build
 * one directly instead of constructing a real DOM event. Every modifier defaults to `false`, matching
 * an unmodified keypress. */
function press(key: string, mods: Partial<Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>> = {}) {
  return { key, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...mods };
}

describe('handleKey — menu closed', () => {
  test('ArrowDown moves to the next index', () => {
    const result = handleKey(press('ArrowDown'), makeState({ selectedIndex: 0, resultCount: 3 }));
    expect(result).toEqual({ kind: 'move', selectedIndex: 1, preventDefault: true });
  });

  test('ArrowDown wraps from the last index back to 0', () => {
    const result = handleKey(press('ArrowDown'), makeState({ selectedIndex: 2, resultCount: 3 }));
    expect(result).toEqual({ kind: 'move', selectedIndex: 0, preventDefault: true });
  });

  test('ArrowUp moves to the previous index', () => {
    const result = handleKey(press('ArrowUp'), makeState({ selectedIndex: 2, resultCount: 3 }));
    expect(result).toEqual({ kind: 'move', selectedIndex: 1, preventDefault: true });
  });

  test('ArrowUp wraps from 0 back to the last index', () => {
    const result = handleKey(press('ArrowUp'), makeState({ selectedIndex: 0, resultCount: 3 }));
    expect(result).toEqual({ kind: 'move', selectedIndex: 2, preventDefault: true });
  });

  test('ArrowDown/ArrowUp with zero results is a no-op', () => {
    expect(handleKey(press('ArrowDown'), makeState({ resultCount: 0 }))).toEqual({ kind: 'none', preventDefault: false });
    expect(handleKey(press('ArrowUp'), makeState({ resultCount: 0 }))).toEqual({ kind: 'none', preventDefault: false });
  });

  test('Enter runs the default action', () => {
    const result = handleKey(press('Enter'), makeState());
    expect(result).toEqual({ kind: 'runDefault', preventDefault: true });
  });

  test('Tab fills the input with the selected title, unprefixed in All mode', () => {
    const result = handleKey(press('Tab'), makeState({ modePrefix: '', selectedTitle: 'Order' }));
    expect(result).toEqual({ kind: 'fill', query: 'Order', preventDefault: true });
  });

  test.each([
    ['>', 'New file'],
    ['@', 'Order'],
    ['#', 'OrderPlaced'],
    ['/', 'ordering.koi'],
    [':', 'Order'],
  ])('Tab fills with the %s mode prefix', (prefix, title) => {
    const result = handleKey(press('Tab'), makeState({ modePrefix: prefix, selectedTitle: title }));
    expect(result).toEqual({ kind: 'fill', query: `${prefix}${title}`, preventDefault: true });
  });

  test('Tab with no selected title fills nothing but still traps focus (preventDefault, kind none)', () => {
    // #1145 review: even with no result to fill, Tab must be prevented so the browser's default focus
    // move can't escape the modal overlay.
    const result = handleKey(press('Tab'), makeState({ selectedTitle: null }));
    expect(result).toEqual({ kind: 'none', preventDefault: true });
  });

  test('Escape is no longer the reducer\'s concern — the shared Esc-stack owns it (#1164)', () => {
    // The launcher joins koine-ui's shared Esc-stack, whose launcher layer clears a non-empty query
    // else closes. So the reducer returns `none` (preventDefault false) and lets Escape bubble to the
    // shared document handler — regardless of whether the query is empty or not.
    expect(handleKey(press('Escape'), makeState({ query: 'Or' }))).toEqual({ kind: 'none', preventDefault: false });
    expect(handleKey(press('Escape'), makeState({ query: '' }))).toEqual({ kind: 'none', preventDefault: false });
  });

  test('Cmd+K toggles the action menu', () => {
    const result = handleKey(press('k', { metaKey: true }), makeState());
    expect(result).toEqual({ kind: 'toggleMenu', preventDefault: true });
  });

  test('Ctrl+K also toggles the action menu', () => {
    const result = handleKey(press('K', { ctrlKey: true }), makeState());
    expect(result).toEqual({ kind: 'toggleMenu', preventDefault: true });
  });

  test('a plain character key is a no-op (typing is not swallowed)', () => {
    const result = handleKey(press('a'), makeState());
    expect(result).toEqual({ kind: 'none', preventDefault: false });
  });
});

describe('handleKey — menu open', () => {
  test('ArrowDown moves the menu selection and wraps', () => {
    const closed = makeState({ menuOpen: true, menuIndex: 0, menuCount: 3 });
    expect(handleKey(press('ArrowDown'), closed)).toEqual({ kind: 'menuMove', menuIndex: 1, preventDefault: true });

    const atEnd = makeState({ menuOpen: true, menuIndex: 2, menuCount: 3 });
    expect(handleKey(press('ArrowDown'), atEnd)).toEqual({ kind: 'menuMove', menuIndex: 0, preventDefault: true });
  });

  test('ArrowUp moves the menu selection and wraps', () => {
    const atStart = makeState({ menuOpen: true, menuIndex: 0, menuCount: 3 });
    expect(handleKey(press('ArrowUp'), atStart)).toEqual({ kind: 'menuMove', menuIndex: 2, preventDefault: true });

    const mid = makeState({ menuOpen: true, menuIndex: 2, menuCount: 3 });
    expect(handleKey(press('ArrowUp'), mid)).toEqual({ kind: 'menuMove', menuIndex: 1, preventDefault: true });
  });

  test('Enter runs the selected menu action', () => {
    const result = handleKey(press('Enter'), makeState({ menuOpen: true }));
    expect(result).toEqual({ kind: 'runMenu', preventDefault: true });
  });

  test('Escape while the menu is open is a reducer no-op — the shared stack\'s menu layer closes it (#1164)', () => {
    // The action menu registers its own layer on koine-ui's shared Esc-stack (topmost while open), so
    // Escape is dismissed there; the reducer returns `none` and lets Escape bubble to the shared handler.
    const result = handleKey(press('Escape'), makeState({ menuOpen: true, query: 'Or' }));
    expect(result).toEqual({ kind: 'none', preventDefault: false });
  });

  test('Cmd+K toggles (closes) the menu', () => {
    const result = handleKey(press('k', { metaKey: true }), makeState({ menuOpen: true }));
    expect(result).toEqual({ kind: 'toggleMenu', preventDefault: true });
  });

  test('other keys pass through as none so typing is not swallowed while the menu is open', () => {
    const result = handleKey(press('a'), makeState({ menuOpen: true }));
    expect(result).toEqual({ kind: 'none', preventDefault: false });
  });
});
