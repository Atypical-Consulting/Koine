import { describe, it, expect, vi, beforeEach } from 'vitest';

// Drive TauriPlatform's app-data workspace logic against a mocked Tauri path + IPC, so the desktop
// token rules run without a real Tauri runtime. `join` mirrors the real POSIX behavior (slash-joined);
// `appDataDir` is a fixed root. Only these two surfaces are exercised here — tauri.ts's other imports
// load normally under happy-dom (they only fail when CALLED outside Tauri, which we don't do).
const { appDataDirMock, joinMock, invokeMock } = vi.hoisted(() => ({
  appDataDirMock: vi.fn(async () => '/appdata'),
  joinMock: vi.fn(async (...parts: string[]) => parts.join('/')),
  invokeMock: vi.fn(async () => undefined),
}));
vi.mock('@tauri-apps/api/path', () => ({ appDataDir: appDataDirMock, join: joinMock }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

import { TauriPlatform } from '@/host/tauri';

beforeEach(() => {
  appDataDirMock.mockClear();
  joinMock.mockClear();
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(undefined);
});

describe('TauriPlatform.isAutoRestorableToken', () => {
  const p = new TauriPlatform();

  // The bug: a desktop template token is an absolute `<appData>/workspaces/<id>` path, not a browser
  // `example-*` slug, so the old hardcoded test matched nothing and reloads reverted to the blank model.
  it('vouches for a materialized template dir under <appData>/workspaces/', async () => {
    expect(await p.isAutoRestorableToken('/appdata/workspaces/pizzeria')).toBe(true);
  });

  it('declines the default workspace (<appData>/Untitled has its own re-open flow)', async () => {
    expect(await p.isAutoRestorableToken('/appdata/Untitled')).toBe(false);
  });

  it('declines an externally picked folder (stays a manual Recents click)', async () => {
    expect(await p.isAutoRestorableToken('/Users/me/projects/billing')).toBe(false);
  });

  // The mint side and the recognize side must agree: materializeWorkspace returns exactly the token
  // isAutoRestorableToken later accepts (both built from the shared WORKSPACES_SUBDIR).
  it('materializeWorkspace mints exactly the token it later vouches for', async () => {
    const token = await p.materializeWorkspace('pizzeria', [{ relPath: 'menu.koi', contents: '' }]);
    expect(token).toBe('/appdata/workspaces/pizzeria');
    expect(await p.isAutoRestorableToken(token as string)).toBe(true);
  });
});
