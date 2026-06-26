// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { chordFromEvent, prettyChord } from '@/shared/platform';

// chordFromEvent is a pure keydown→CodeMirror-key normalizer; unit-test it directly (no DOM/UI).
// It lives beside formatChord/prettyChord in shared/platform — the platform-string helpers.
describe('chordFromEvent', () => {
  const ev = (init: KeyboardEventInit) => new KeyboardEvent('keydown', init);

  it('maps a plain function key', () => {
    expect(chordFromEvent(ev({ key: 'F2' }))).toBe('F2');
  });
  it('maps Ctrl+D to a portable Mod chord', () => {
    expect(chordFromEvent(ev({ key: 'd', ctrlKey: true }))).toBe('Mod-d');
  });
  it('maps Shift+F12', () => {
    expect(chordFromEvent(ev({ key: 'F12', shiftKey: true }))).toBe('Shift-F12');
  });
  it('maps Ctrl+. (a punctuation key)', () => {
    expect(chordFromEvent(ev({ key: '.', ctrlKey: true }))).toBe('Mod-.');
  });
  it('returns null for a bare modifier (keep waiting for a real key)', () => {
    expect(chordFromEvent(ev({ key: 'Shift', shiftKey: true }))).toBeNull();
    expect(chordFromEvent(ev({ key: 'Control', ctrlKey: true }))).toBeNull();
    expect(chordFromEvent(ev({ key: 'Alt', altKey: true }))).toBeNull();
    expect(chordFromEvent(ev({ key: 'Meta', metaKey: true }))).toBeNull();
  });
  it('lowercases the base and orders modifiers Mod-Shift', () => {
    expect(chordFromEvent(ev({ key: 'K', ctrlKey: true, shiftKey: true }))).toBe('Mod-Shift-k');
  });
});

// prettyChord renders a stored CodeMirror key as a platform display string. MOD is 'Ctrl' off macOS,
// which the test environment reports (see the 'Ctrl+S' assertions in prefs.test.ts).
describe('prettyChord', () => {
  it('renders a Mod chord with the platform modifier and an uppercased base', () => {
    expect(prettyChord('Mod-s')).toBe('Ctrl+S');
  });
  it('keeps a base key that is itself "-" intact (front-strips prefixes, not split on "-")', () => {
    // 'Mod--' is Ctrl+minus — front-stripping the 'Mod-' prefix leaves '-', so it must render
    // 'Ctrl+-' and never a garbled 'Ctrl++'.
    expect(prettyChord('Mod--')).toBe('Ctrl+-');
  });
  it('orders and renders multiple modifiers', () => {
    expect(prettyChord('Mod-Shift-k')).toBe('Ctrl+Shift+K');
  });
  it('renders an empty (deliberately unbound) override as "Unbound"', () => {
    expect(prettyChord('')).toBe('Unbound');
  });
  it('round-trips a chord recorded by chordFromEvent', () => {
    const chord = chordFromEvent(new KeyboardEvent('keydown', { key: 'd', ctrlKey: true }));
    expect(chord).toBe('Mod-d');
    expect(prettyChord(chord as string)).toBe('Ctrl+D');
  });
});
