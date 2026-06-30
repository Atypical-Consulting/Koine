import { describe, it, expect, vi, beforeEach } from 'vitest';

// Drive TauriPlatform's app-data workspace logic against a mocked Tauri path + IPC, so the desktop
// token rules run without a real Tauri runtime. `join` mirrors the real POSIX behavior (slash-joined);
// `appDataDir` is a fixed root. Only these two surfaces are exercised here — tauri.ts's other imports
// load normally under happy-dom (they only fail when CALLED outside Tauri, which we don't do).
const { appDataDirMock, joinMock, invokeMock } = vi.hoisted(() => ({
  appDataDirMock: vi.fn(async () => '/appdata'),
  joinMock: vi.fn(async (...parts: string[]) => parts.join('/')),
  // Typed loosely (variadic in, `unknown` out) so a test can swap in a stateful `mockImplementation`
  // that returns the real IPC shapes (a KoiFile[] from list_koi_files, a path string from create_file)
  // without fighting a `Promise<undefined>` inference.
  invokeMock: vi.fn(async (_cmd?: string, _payload?: Record<string, unknown>): Promise<unknown> => undefined),
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
    expect(dir).toBe('/appdata/workspaces/pizzeria');
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
