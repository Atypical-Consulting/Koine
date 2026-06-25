import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Stub the IDE shell so booting doesn't pull the whole editor module graph, and so we can assert
// whether init() runs per route. The real init() is exercised exhaustively in ide.test.ts.
const { ideInit } = vi.hoisted(() => ({ ideInit: vi.fn<() => () => void>(() => () => {}) }));
vi.mock('@/shell/ide', () => ({ init: ideInit }));

import { bootStudio } from '../main';
import { appStore } from '@/store';

let dispose: (() => void) | null = null;

beforeEach(() => {
  ideInit.mockClear();
  appStore.setState({ route: 'home' });
  localStorage.clear();
  location.hash = '';
  document.body.innerHTML = '';
});

afterEach(() => {
  dispose?.();
  dispose = null;
});

describe('bootStudio — a single routed view (no IDE→Home flash)', () => {
  it('a pristine boot mounts Home and does NOT start the IDE', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);

    dispose = bootStudio(root);

    expect(root.querySelector('.koi-welcome')).not.toBeNull();
    expect(ideInit).not.toHaveBeenCalled();
    // The editor and Home are never both mounted — that co-mounting was the flash.
    expect(document.body.querySelector('#app')).toBeNull();
  });

  it('navigating to the editor starts the IDE once and tears Home down', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);

    dispose = bootStudio(root);
    appStore.getState().navigate('editor');

    expect(ideInit).toHaveBeenCalledTimes(1);
    expect(root.querySelector('.koi-welcome')).toBeNull();
  });

  it('a previously-open workspace boots straight to the editor', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    // The synchronous "a workspace was open" flag — written by markWorkspaceOpened().
    localStorage.setItem('koine.studio.workspace-opened', '1');

    dispose = bootStudio(root);

    expect(ideInit).toHaveBeenCalledTimes(1);
    expect(root.querySelector('.koi-welcome')).toBeNull();
  });
});
