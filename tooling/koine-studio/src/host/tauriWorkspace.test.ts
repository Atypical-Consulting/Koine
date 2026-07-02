import { describe, it, expect, vi, beforeEach } from 'vitest';

// Drive TauriPlatform's workspace logic against a mocked Tauri path + IPC, so the desktop token rules
// run without a real Tauri runtime. `join` mirrors the real POSIX behavior (slash-joined);
// `documentDir` is the new user-owned workspace root (`<documentDir>/Koine`) and `appDataDir` is the
// legacy root still honored for back-compat. Only these surfaces are exercised here — tauri.ts's other
// imports load normally under happy-dom (they only fail when CALLED outside Tauri, which we don't do).
const { appDataDirMock, documentDirMock, joinMock, invokeMock } = vi.hoisted(() => ({
  appDataDirMock: vi.fn(async () => '/appdata'),
  documentDirMock: vi.fn(async () => '/documents'),
  joinMock: vi.fn(async (...parts: string[]) => parts.join('/')),
  // Typed loosely (variadic in, `unknown` out) so a test can swap in a stateful `mockImplementation`
  // that returns the real IPC shapes (a KoiFile[] from list_koi_files, a path string from create_file)
  // without fighting a `Promise<undefined>` inference.
  invokeMock: vi.fn(async (_cmd?: string, _payload?: Record<string, unknown>): Promise<unknown> => undefined),
}));
vi.mock('@tauri-apps/api/path', () => ({
  appDataDir: appDataDirMock,
  documentDir: documentDirMock,
  join: joinMock,
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

import { TauriPlatform } from '@/host/tauri';

beforeEach(() => {
  appDataDirMock.mockClear();
  documentDirMock.mockClear();
  joinMock.mockClear();
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(undefined);
});

describe('TauriPlatform.isAutoRestorableToken', () => {
  const p = new TauriPlatform();

  // #915: cold boot must silently re-open a materialized workspace under the NEW `<documentDir>/Koine/`
  // root — an absolute path, not a browser `example-*` slug.
  it('vouches for a materialized workspace under the new <documentDir>/Koine/ root', async () => {
    expect(await p.isAutoRestorableToken('/documents/Koine/pizzeria')).toBe(true);
  });

  // Back-compat: pre-#915 desktop tokens live under `<appData>/workspaces/` and must STILL cold-boot
  // restore (union with the new root) so an upgrading user doesn't lose their auto-reopen.
  it('vouches for a legacy materialized dir under <appData>/workspaces/ (back-compat)', async () => {
    expect(await p.isAutoRestorableToken('/appdata/workspaces/pizzeria')).toBe(true);
  });

  it('declines the new default workspace (<documentDir>/Koine/Untitled has its own re-open flow)', async () => {
    expect(await p.isAutoRestorableToken('/documents/Koine/Untitled')).toBe(false);
  });

  it('declines the legacy default workspace (<appData>/Untitled has its own re-open flow)', async () => {
    expect(await p.isAutoRestorableToken('/appdata/Untitled')).toBe(false);
  });

  it('declines an externally picked folder (stays a manual Recents click)', async () => {
    expect(await p.isAutoRestorableToken('/Users/me/projects/billing')).toBe(false);
  });
});

// #915: the desktop workspace root moved from the hidden `<appData>/workspaces/<name>` to the
// discoverable, user-owned `<documentDir>/Koine/<name>` (e.g. ~/Documents/Koine/billing). Both the
// template mint side (materializeWorkspace) and the default scratch model (defaultWorkspace) resolve
// through the shared `workspacesRoot()` = `<documentDir>/Koine`.
describe('TauriPlatform workspace root (<documentDir>/Koine, #915)', () => {
  const p = new TauriPlatform();

  it('materializeWorkspace mints under <documentDir>/Koine/', async () => {
    const token = await p.materializeWorkspace('pizzeria', [{ relPath: 'menu.koi', contents: '' }]);
    expect(token).toBe('/documents/Koine/pizzeria');
  });

  // The mint side and the recognize side must agree: materializeWorkspace returns exactly the token
  // isAutoRestorableToken later accepts (both derive from the shared workspacesRoot()).
  it('materializeWorkspace mints exactly the token it later vouches for', async () => {
    const token = await p.materializeWorkspace('pizzeria', [{ relPath: 'menu.koi', contents: '' }]);
    expect(token).toBe('/documents/Koine/pizzeria');
    expect(await p.isAutoRestorableToken(token as string)).toBe(true);
  });

  it('defaultWorkspace resolves the scratch model under <documentDir>/Koine/Untitled', async () => {
    // defaultWorkspace reads back listKoiFiles before seeding — return an empty workspace so it seeds once.
    invokeMock.mockImplementation(async (cmd?: string) => (cmd === 'list_koi_files' ? [] : undefined));
    expect(await p.defaultWorkspace('model {}')).toBe('/documents/Koine/Untitled');
  });
});

// #816: on the desktop host, materializeWorkspace(persist=true) must seed an example's files only on
// first creation and then PRESERVE the user's edits across re-opens — mirroring the browser host and the
// desktop's own defaultWorkspace seed-once idiom. persist false/omitted keeps the wipe-and-rewrite
// (shared-import) semantics, where each open reflects exactly its own payload.
describe('TauriPlatform.materializeWorkspace persist (seed-once vs wipe-and-rewrite, #816)', () => {
  const p = new TauriPlatform();

  // A stateful in-memory stand-in for the Rust workspace FS so the seed-once branch (which reads back
  // listKoiFiles before deciding to write) sees what earlier createFile calls wrote. Keyed by absolute
  // dir → relPath → contents; list_koi_files reports only the `.koi` entries, like the real command.
  let stored: Map<string, Map<string, string>>;

  beforeEach(() => {
    stored = new Map();
    invokeMock.mockImplementation(async (cmd?: string, payload: Record<string, unknown> = {}) => {
      if (cmd === 'create_file') {
        const folder = payload.folder as string;
        const relPath = payload.relPath as string;
        if (!stored.has(folder)) stored.set(folder, new Map());
        stored.get(folder)!.set(relPath, (payload.contents as string) ?? '');
        return `${folder}/${relPath}`;
      }
      if (cmd === 'delete_entry') {
        stored.delete(payload.token as string);
        return undefined;
      }
      if (cmd === 'list_koi_files') {
        const dir = payload.dir as string;
        const files = stored.get(dir);
        if (!files) return [];
        return [...files.keys()]
          .filter((rel) => rel.endsWith('.koi'))
          .map((rel) => ({ path: `${dir}/${rel}`, name: rel.split('/').pop()!, relPath: rel }));
      }
      return undefined;
    });
  });

  it('persist=true seeds once and preserves a user edit on re-open', async () => {
    const bundled = [{ relPath: 'order.koi', contents: 'context Ordering {}' }];

    // First open seeds the pristine template into the (empty) materialized dir.
    const dir = (await p.materializeWorkspace('pizzeria', bundled, true)) as string;
    expect(dir).toBe('/documents/Koine/pizzeria');
    expect(stored.get(dir)!.get('order.koi')).toBe('context Ordering {}');

    // The user edits order.koi inside the materialized workspace.
    stored.get(dir)!.set('order.koi', 'context Ordering {}\n// my edit');

    // Re-opening the SAME example must NOT re-seed — the edit survives.
    await p.materializeWorkspace('pizzeria', bundled, true);
    expect(stored.get(dir)!.get('order.koi')).toBe('context Ordering {}\n// my edit');

    // The seed-once path must never wipe the existing folder, and must write files only the first time.
    expect(invokeMock.mock.calls.filter((c) => c[0] === 'delete_entry')).toHaveLength(0);
    expect(invokeMock.mock.calls.filter((c) => c[0] === 'create_file')).toHaveLength(1);
  });

  it('persist omitted/false still wipes and rewrites (one-shot shared-import semantics)', async () => {
    const bundled = [{ relPath: 'a.koi', contents: 'context A {}' }];

    const dir = (await p.materializeWorkspace('shared', bundled)) as string;
    expect(stored.get(dir)!.get('a.koi')).toBe('context A {}');

    // A user edit is NOT preserved when persist is false: the next open wipes and re-seeds the pristine copy.
    stored.get(dir)!.set('a.koi', 'context A {}\n// edit that must be discarded');
    await p.materializeWorkspace('shared', bundled);

    expect(stored.get(dir)!.get('a.koi')).toBe('context A {}');
    expect(invokeMock.mock.calls.filter((c) => c[0] === 'delete_entry')).toContainEqual(['delete_entry', { token: dir }]);
  });
});

// #915: an upgrading desktop user's pre-existing workspaces (under the legacy `<appData>` roots) are
// best-effort migrated into the new `<documentDir>/Koine` root on first boot (the defaultWorkspace
// path), so they surface in the discoverable location too. The move runs at most once, only into a
// still-empty new root, and never throws into the boot path.
describe('TauriPlatform legacy workspace migration (#915)', () => {
  it('moves legacy <appData>/workspaces/* into <documentDir>/Koine on first boot', async () => {
    const p = new TauriPlatform(); // the once-only guard is per-instance
    const moves: Array<Record<string, unknown>> = [];
    invokeMock.mockImplementation(async (cmd?: string, payload: Record<string, unknown> = {}) => {
      if (cmd === 'list_entries') {
        const dir = payload.dir as string;
        if (dir === '/documents/Koine') return []; // new root still empty → migrate
        if (dir === '/appdata/workspaces')
          return [{ token: '/appdata/workspaces/billing', name: 'billing', relPath: 'billing', kind: 'dir' }];
        return []; // /appdata/Untitled empty
      }
      if (cmd === 'move_entry') {
        moves.push(payload);
        return `${payload.destFolder}/${payload.newRelPath}`;
      }
      if (cmd === 'list_koi_files') return []; // defaultWorkspace then seeds a fresh Untitled
      return undefined; // create_file etc.
    });

    await p.defaultWorkspace('model {}');
    expect(moves).toContainEqual({
      token: '/appdata/workspaces/billing',
      destFolder: '/documents/Koine',
      newRelPath: 'billing',
      copy: false,
    });

    // A second boot must NOT migrate again (the once-only guard).
    moves.length = 0;
    await p.defaultWorkspace('model {}');
    expect(moves).toHaveLength(0);
  });

  it('is a no-op when the new <documentDir>/Koine root already holds workspaces', async () => {
    const p = new TauriPlatform();
    const moves: Array<Record<string, unknown>> = [];
    invokeMock.mockImplementation(async (cmd?: string, payload: Record<string, unknown> = {}) => {
      if (cmd === 'list_entries') {
        const dir = payload.dir as string;
        if (dir === '/documents/Koine')
          return [{ token: '/documents/Koine/billing', name: 'billing', relPath: 'billing', kind: 'dir' }];
        return [{ token: '/appdata/workspaces/legacy', name: 'legacy', relPath: 'legacy', kind: 'dir' }];
      }
      if (cmd === 'move_entry') {
        moves.push(payload);
        return 'moved';
      }
      if (cmd === 'list_koi_files')
        return [{ path: '/documents/Koine/Untitled/model.koi', name: 'model.koi', relPath: 'model.koi' }];
      return undefined;
    });

    await p.defaultWorkspace('model {}');
    expect(moves).toHaveLength(0);
  });

  it('swallows an invoke rejection so boot never breaks', async () => {
    const p = new TauriPlatform();
    invokeMock.mockImplementation(async (cmd?: string) => {
      if (cmd === 'list_entries') throw new Error('fs blew up');
      if (cmd === 'list_koi_files') return [];
      return undefined;
    });
    // defaultWorkspace must still resolve to the new-root Untitled despite the migration probe throwing.
    await expect(p.defaultWorkspace('model {}')).resolves.toBe('/documents/Koine/Untitled');
  });
});
