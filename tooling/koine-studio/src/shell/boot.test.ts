import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { saveSettings, DEFAULT_SETTINGS } from '@/settings/persistence';

// Stub the IDE shell so booting doesn't pull the whole editor module graph, and so we can assert
// whether init() runs per route. The real init() is exercised exhaustively in ide.test.ts.
const { ideInit } = vi.hoisted(() => ({
  ideInit: vi.fn<(hooks?: { onOpenRecentFailed?: (path: string, reason: 'unreadable' | 'empty') => void }) => () => void>(
    () => () => {},
  ),
}));
vi.mock('@/shell/ide', () => ({ init: ideInit }));

// Mock the shared live-region announcer (#522) so the perceivability-gated announcement (#573) is
// observable without a real DOM live region. main.ts wires the affordances to this default announce.
const { announceMock } = vi.hoisted(() => ({ announceMock: vi.fn() }));
vi.mock('@/shell/liveRegion', () => ({ announce: announceMock, LIVE_REGION_ID: 'koi-live-region' }));

import { bootStudio } from '../main';
import { appStore } from '@/store';
import { takeStartIntent } from '@/shell/bootIntent';
import { INSTALL_ANNOUNCEMENT, type BeforeInstallPromptEvent } from '@/shell/pwaInstall';
import { buildShareUrl } from '@/export/share';

let dispose: (() => void) | null = null;

beforeEach(() => {
  ideInit.mockClear();
  announceMock.mockClear();
  appStore.setState({ route: 'home' });
  localStorage.clear();
  location.hash = '';
  document.body.innerHTML = '';
  takeStartIntent(); // drain any intent a prior test queued (init() is mocked, so nothing consumes it)
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

  it('a previously-open workspace now lands on Home (not the editor) with a one-click Resume control (#766)', () => {
    const root = document.createElement('div');
    root.hidden = true; // mirror index.html's `<div id="home-root" hidden>` so the reveal is observable
    document.body.appendChild(root);
    // The synchronous "a workspace was open" flag — written by markWorkspaceOpened(). An empty hash.
    localStorage.setItem('koine.studio.workspace-opened', '1');

    dispose = bootStudio(root);

    // Opening always lands on Home; the persisted flag no longer auto-skips into the editor (#766).
    expect(root.querySelector('.koi-welcome')).not.toBeNull();
    expect(root.hidden).toBe(false); // showHome() actually un-hid #home-root (was hidden pre-boot)
    expect(ideInit).not.toHaveBeenCalled(); // the editor is NOT booted on a plain open
    // The returning-user fast path survives as a one-click Resume on cold-open Home.
    expect(root.querySelector('[data-action="resume"]')).not.toBeNull();
  });

  it('a #model=… share link still boots straight to the editor (the only non-#/editor path to it) (#766)', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    // After #766 resolveInitialRoute returns 'editor' ONLY for #/editor, so the isShareLink short-circuit
    // in bootStudio is the sole guarantee a shared playground link still opens the editor — guard it here.
    const url = buildShareUrl('context Demo {}');
    location.hash = url.slice(url.indexOf('#'));

    dispose = bootStudio(root);

    expect(ideInit).toHaveBeenCalledTimes(1);
    expect(root.querySelector('.koi-welcome')).toBeNull();
  });

  it('a cold #/editor deep link (no persisted workspace) boots to the editor, not Home', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    location.hash = '#/editor';

    dispose = bootStudio(root);

    expect(ideInit).toHaveBeenCalledTimes(1);
    expect(root.querySelector('.koi-welcome')).toBeNull();
  });

  it('a Home action persists the workspace flag and navigates to the editor', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);

    dispose = bootStudio(root); // pristine → Home
    expect(root.querySelector('.koi-welcome')).not.toBeNull();

    // Clicking a start action sends the user into the editor and remembers a workspace was opened, so a
    // later cold-open Home offers a one-click Resume back to it (#766).
    root.querySelector<HTMLButtonElement>('[data-action="open-folder"]')!.click();

    expect(localStorage.getItem('koine.studio.workspace-opened')).toBe('1');
    expect(ideInit).toHaveBeenCalledTimes(1);
    expect(root.querySelector('.koi-welcome')).toBeNull();
  });

  it('a pristine Home offers no Resume-editing control (no session to resume yet)', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);

    dispose = bootStudio(root); // pristine → Home, IDE never booted

    expect(root.querySelector('.koi-welcome')).not.toBeNull();
    expect(root.querySelector('[data-action="resume"]')).toBeNull();
  });

  it('reflects the active route on document.body.dataset.route (so CSS can trim the toolbar on Home)', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);

    dispose = bootStudio(root); // pristine → Home
    expect(document.body.dataset.route).toBe('home');

    appStore.getState().navigate('editor');
    expect(document.body.dataset.route).toBe('editor');

    appStore.getState().navigate('home');
    expect(document.body.dataset.route).toBe('home');
  });

  it('once the editor has booted, returning Home offers a Resume-editing control that navigates back without re-initing', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);

    dispose = bootStudio(root); // pristine → Home
    appStore.getState().navigate('editor'); // boot the IDE (a session is now live)
    expect(ideInit).toHaveBeenCalledTimes(1);

    appStore.getState().navigate('home'); // brand → Home, with the session still alive behind the route
    const resume = root.querySelector<HTMLButtonElement>('[data-action="resume"]');
    expect(resume).not.toBeNull();

    resume!.click();
    expect(appStore.getState().route).toBe('editor'); // resumed into the live session
    expect(ideInit).toHaveBeenCalledTimes(1); // resumed, not re-initialised
    expect(root.querySelector('.koi-welcome')).toBeNull();
  });

  it('a dead open-recent reported by the IDE returns to Home and offers to forget the entry there (#391)', async () => {
    // The IDE reports a failed open-recent through the hook bootStudio injects (#391) instead of
    // painting the legacy welcome overlay over the editor. Capture that hook from the mocked init().
    let hooks: { onOpenRecentFailed?: (path: string, reason: 'unreadable' | 'empty') => void } | undefined;
    ideInit.mockImplementationOnce((h) => {
      hooks = h;
      return () => {};
    });

    localStorage.setItem('koine.studio.recentFolders', JSON.stringify(['ghost']));
    const root = document.createElement('div');
    document.body.appendChild(root);

    dispose = bootStudio(root);
    appStore.getState().navigate('editor'); // boots the (mocked) IDE → captures the hook
    expect(hooks?.onOpenRecentFailed).toBeTypeOf('function');

    // The IDE hits a dead recent and reports it: bootStudio must return to Home and surface the
    // "Remove from Recent?" recovery confirm there — never as an overlay over the editor.
    hooks!.onOpenRecentFailed!('ghost', 'unreadable');
    expect(appStore.getState().route).toBe('home');
    expect(root.querySelector('.koi-welcome')).not.toBeNull();

    const okBtn = document.querySelector<HTMLButtonElement>('.koi-confirm-btn-danger');
    expect(okBtn).not.toBeNull();
    okBtn!.click();
    await Promise.resolve(); // let recover()'s confirm promise settle, then remove + refresh
    await Promise.resolve();

    // The dead recent is forgotten and the recents list rebuilt to its empty state on Home.
    expect(localStorage.getItem('koine.studio.recentFolders')).not.toContain('ghost');
    expect(root.querySelector('.koi-welcome-empty')).not.toBeNull();
  });
});

describe('bootStudio — On startup setting (#770)', () => {
  it('startupView:lastWorkspace + persisted workspace boots straight to the editor', () => {
    // Set the "last workspace opened" flag (hasPersistedWorkspace) and the setting.
    localStorage.setItem('koine.studio.workspace-opened', '1');
    saveSettings({ ...DEFAULT_SETTINGS, startupView: 'lastWorkspace' });

    const root = document.createElement('div');
    document.body.appendChild(root);

    dispose = bootStudio(root);

    // Should boot straight into the editor (opt-in auto-resume).
    expect(ideInit).toHaveBeenCalledTimes(1);
    expect(root.querySelector('.koi-welcome')).toBeNull();
  });

  it('startupView:home + persisted workspace still lands on Home (default unchanged)', () => {
    localStorage.setItem('koine.studio.workspace-opened', '1');
    saveSettings({ ...DEFAULT_SETTINGS, startupView: 'home' });

    const root = document.createElement('div');
    document.body.appendChild(root);

    dispose = bootStudio(root);

    // Home remains the default — the #766 behaviour is unchanged.
    expect(root.querySelector('.koi-welcome')).not.toBeNull();
    expect(ideInit).not.toHaveBeenCalled();
  });

  it('startupView:lastWorkspace + NO workspace still lands on Home (never blank-editor strand)', () => {
    // No workspace-opened flag and no workspace token.
    saveSettings({ ...DEFAULT_SETTINGS, startupView: 'lastWorkspace' });

    const root = document.createElement('div');
    document.body.appendChild(root);

    dispose = bootStudio(root);

    // Without a prior workspace, the opt-in falls back to Home.
    expect(root.querySelector('.koi-welcome')).not.toBeNull();
    expect(ideInit).not.toHaveBeenCalled();
  });

  it('a share link always boots to the editor regardless of startupView', () => {
    saveSettings({ ...DEFAULT_SETTINGS, startupView: 'lastWorkspace' });
    // No workspace flag — but a share link wins everything.
    const url = buildShareUrl('context Demo {}');
    location.hash = url.slice(url.indexOf('#'));

    const root = document.createElement('div');
    document.body.appendChild(root);

    dispose = bootStudio(root);

    expect(ideInit).toHaveBeenCalledTimes(1);
    expect(root.querySelector('.koi-welcome')).toBeNull();
  });
});

describe('bootStudio — affordance announcements gated on the editor route (#573)', () => {
  // The install affordance markup the shell ships inside #app (present but hidden until the editor route).
  function mountInstallAffordance(): void {
    const app = document.createElement('div');
    app.id = 'app';
    app.hidden = true;
    const root = document.createElement('div');
    root.id = 'install-affordance';
    root.hidden = true;
    const installButton = document.createElement('button');
    installButton.id = 'btn-install';
    const dismissButton = document.createElement('button');
    dismissButton.id = 'btn-install-dismiss';
    root.append(installButton, dismissButton);
    app.append(root);
    document.body.append(app);
  }
  // Fire a beforeinstallprompt on window — the install affordance's default event target.
  function fireBeforeInstallPrompt(): void {
    const e = new Event('beforeinstallprompt', { cancelable: true }) as BeforeInstallPromptEvent;
    (e as unknown as { prompt: () => Promise<void> }).prompt = () => Promise.resolve();
    (e as unknown as { userChoice: Promise<unknown> }).userChoice = Promise.resolve({
      outcome: 'accepted',
      platform: 'web',
    });
    window.dispatchEvent(e);
  }

  it('an install affordance armed on Home announces only after the route flips to the editor', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    mountInstallAffordance();

    dispose = bootStudio(root); // pristine → Home; the toolbar's #app is route-hidden
    expect(appStore.getState().route).toBe('home');

    fireBeforeInstallPrompt(); // installable while still on Home → revealed, but not yet perceivable
    expect(announceMock).not.toHaveBeenCalled();

    appStore.getState().navigate('editor'); // the editor toolbar becomes perceivable → flush the defer
    expect(announceMock).toHaveBeenCalledTimes(1);
    expect(announceMock).toHaveBeenCalledWith(INSTALL_ANNOUNCEMENT);
  });
});
