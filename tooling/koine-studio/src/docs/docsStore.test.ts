import { describe, it, expect } from 'vitest';
import type { FsEntry, Platform } from '@/host';
import { parseAdr } from '@/docs/adr';
import { ADR_DIR, NOTES_DIR, createDocsStore } from '@/docs/docsStore';

// --- in-memory mock of the host file abstraction -----------------------------
// Only the four methods docsStore touches are implemented (listDir / readTextFile / writeTextFile /
// createFile); the rest of Platform is left unimplemented (the store never calls them). Tokens use
// the browser scheme `<folder>/<relPath>`; the folder token is 'WS'.
const FOLDER = 'WS';

interface FakeFs {
  platform: Platform;
  files: Map<string, string>;
}

function fakeFs(initial: Record<string, string> = {}): FakeFs {
  const files = new Map<string, string>();
  for (const [rel, contents] of Object.entries(initial)) files.set(`${FOLDER}/${rel}`, contents);

  const platform = {
    async listDir(folderToken: string, relPath: string): Promise<FsEntry[]> {
      const prefix = `${folderToken}/${relPath}/`;
      const childNames = new Map<string, 'file' | 'dir'>();
      for (const token of files.keys()) {
        if (!token.startsWith(prefix)) continue;
        const rest = token.slice(prefix.length);
        const slash = rest.indexOf('/');
        if (slash < 0) childNames.set(rest, 'file');
        else childNames.set(rest.slice(0, slash), 'dir');
      }
      if (childNames.size === 0) throw new Error('NotFound: ' + relPath);
      return [...childNames].map(([name, kind]) => ({
        token: `${prefix}${name}`,
        name,
        relPath: `${relPath}/${name}`,
        kind,
      }));
    },
    async readTextFile(token: string): Promise<string> {
      if (!files.has(token)) throw new Error('not found: ' + token);
      return files.get(token)!;
    },
    async writeTextFile(token: string, contents: string): Promise<void> {
      files.set(token, contents);
    },
    async createFile(folderToken: string, relPath: string, contents?: string): Promise<string> {
      const token = `${folderToken}/${relPath}`;
      if (files.has(token)) throw new Error('already exists: ' + relPath);
      files.set(token, contents ?? '');
      return token;
    },
  } as unknown as Platform;

  return { platform, files };
}

describe('docsStore — ADRs', () => {
  it('lists ADRs parsed and sorted by number, ignoring non-markdown', () => {
    const { platform } = fakeFs({
      [`${ADR_DIR}/0002-second.md`]: '# 2. Second\n\n- Status: accepted\n\n## Context\n\nc2\n',
      [`${ADR_DIR}/0001-first.md`]: '# 1. First\n\n- Status: proposed\n\n## Context\n\nc1\n',
      [`${ADR_DIR}/notes.txt`]: 'not an adr',
    });
    const store = createDocsStore(platform, FOLDER);
    return store.listAdrs().then((adrs) => {
      expect(adrs.map((a) => a.number)).toEqual([1, 2]);
      expect(adrs.map((a) => a.name)).toEqual(['0001-first.md', '0002-second.md']);
      expect(adrs[0].adr.title).toBe('First');
      expect(adrs[1].adr.status).toBe('accepted');
    });
  });

  it('returns [] when there is no docs/adr folder yet', async () => {
    const { platform } = fakeFs();
    const store = createDocsStore(platform, FOLDER);
    expect(await store.listAdrs()).toEqual([]);
  });

  it('createAdr writes the next-numbered template file and increments', async () => {
    const { platform, files } = fakeFs();
    const store = createDocsStore(platform, FOLDER);

    const first = await store.createAdr('Use Markdown ADRs');
    expect(first.name).toBe('0001-use-markdown-adrs.md');
    expect(files.has(`${FOLDER}/${ADR_DIR}/0001-use-markdown-adrs.md`)).toBe(true);
    expect(first.adr.status).toBe('proposed');
    expect(first.adr.title).toBe('Use Markdown ADRs');

    const second = await store.createAdr('Adopt CQRS');
    expect(second.name).toBe('0002-adopt-cqrs.md');
    expect((await store.listAdrs()).map((a) => a.number)).toEqual([1, 2]);
  });

  it('createAdr increments past the highest existing number', async () => {
    const { platform } = fakeFs({ [`${ADR_DIR}/0007-existing.md`]: '# 7. Existing\n' });
    const store = createDocsStore(platform, FOLDER);
    const next = await store.createAdr('Another');
    expect(next.name).toBe('0008-another.md');
  });

  it('saveAdr re-renders the canonical markdown to the file', async () => {
    const { platform, files } = fakeFs({
      [`${ADR_DIR}/0001-x.md`]: '# 1. X\n\n- Status: proposed\n\n## Context\n\nold\n',
    });
    const store = createDocsStore(platform, FOLDER);
    const [adrFile] = await store.listAdrs();
    await store.saveAdr(adrFile.token, { ...adrFile.adr, status: 'accepted', decision: 'do it' });

    const written = files.get(`${FOLDER}/${ADR_DIR}/0001-x.md`)!;
    expect(written).toContain('- Status: accepted');
    expect(parseAdr(written).decision).toBe('do it');
  });
});

describe('docsStore — notes', () => {
  it('createNote seeds a heading, listNotes de-slugs the title, read/save round-trip', async () => {
    const { platform, files } = fakeFs();
    const store = createDocsStore(platform, FOLDER);

    const note = await store.createNote('Release process');
    expect(note.name).toBe('release-process.md');
    expect(files.get(`${FOLDER}/${NOTES_DIR}/release-process.md`)).toBe('# Release process\n\n');

    const notes = await store.listNotes();
    expect(notes.map((n) => n.title)).toEqual(['Release process']);

    await store.saveNote(note.token, '# Release process\n\nStep one.\n');
    expect(await store.readNote(note.token)).toBe('# Release process\n\nStep one.\n');
  });

  it('createNote disambiguates a colliding slug', async () => {
    const { platform } = fakeFs({ [`${NOTES_DIR}/release-process.md`]: '# Release process\n' });
    const store = createDocsStore(platform, FOLDER);
    const note = await store.createNote('Release process');
    expect(note.name).toBe('release-process-2.md');
  });
});

describe('docsStore — no-folder (read-only) mode', () => {
  it('lists nothing, cannot write, and rejects create/save', async () => {
    const { platform } = fakeFs();
    const store = createDocsStore(platform, '');
    expect(store.canWrite).toBe(false);
    expect(await store.listAdrs()).toEqual([]);
    expect(await store.listNotes()).toEqual([]);
    await expect(store.createAdr('x')).rejects.toThrow();
    await expect(store.createNote('x')).rejects.toThrow();
    await expect(store.saveAdr('t', parseAdr('# 1. X\n'))).rejects.toThrow();
  });
});
