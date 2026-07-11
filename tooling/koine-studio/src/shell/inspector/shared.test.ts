// Tests for the shared inspector helpers (#1262) — the four small helpers the #985 decomposition left
// duplicated across sibling sub-modules (each pair byte-identical at extraction time), now extracted
// into shared.ts. Each sibling's own suite still pins the behavior at its call sites; these pin the
// shared contracts in isolation.
import { describe, expect, test } from 'vitest';
import { h, render } from 'preact';
import { contextWorkspaceKey, docMessage, visibleCenters } from '@/shell/inspector/shared';
import { DEFAULT_DECK_STATE } from '@/store/slices/uiChrome';

describe('visibleCenters', () => {
  test('overview mode shows all four surfaces in canonical order', () => {
    expect(visibleCenters({ ...DEFAULT_DECK_STATE, mode: 'overview' })).toEqual([
      'visual',
      'technical',
      'output',
      'docs',
    ]);
  });

  test('focus mode without a secondary shows just the primary', () => {
    expect(visibleCenters({ ...DEFAULT_DECK_STATE, primary: 'technical' })).toEqual(['technical']);
  });

  test('a 2-up split shows primary then secondary', () => {
    expect(visibleCenters({ ...DEFAULT_DECK_STATE, primary: 'visual', secondary: 'output' })).toEqual([
      'visual',
      'output',
    ]);
  });
});

describe('contextWorkspaceKey', () => {
  test('a real folder token is the key itself', () => {
    expect(contextWorkspaceKey('folder:abc')).toBe('folder:abc');
  });

  test("no-folder mode ('') falls back to 'scratch'", () => {
    expect(contextWorkspaceKey('')).toBe('scratch');
  });
});

describe('docMessage', () => {
  test('paints a muted <p> with the text by default', () => {
    const host = document.createElement('div');
    docMessage(host, 'Loading…');
    const p = host.querySelector('p');
    expect(p?.className).toBe('muted');
    expect(p?.textContent).toBe('Loading…');
    expect(host.children).toHaveLength(1);
  });

  test("kind 'error' paints a doc-error <p>", () => {
    const host = document.createElement('div');
    docMessage(host, 'boom', 'error');
    expect(host.querySelector('p')?.className).toBe('doc-error');
  });

  test('sets the text via textContent, never as markup', () => {
    const host = document.createElement('div');
    docMessage(host, '<b>bold</b>');
    expect(host.querySelector('b')).toBeNull();
    expect(host.querySelector('p')?.textContent).toBe('<b>bold</b>');
  });

  test('replaces a prior Preact tree (unmount + wipe) with the message', () => {
    const host = document.createElement('div');
    render(h('span', null, 'panel'), host);
    expect(host.querySelector('span')).not.toBeNull();
    docMessage(host, 'Loading…');
    expect(host.querySelector('span')).toBeNull();
    expect(host.children).toHaveLength(1);
    expect(host.firstElementChild?.tagName).toBe('P');
  });
});
