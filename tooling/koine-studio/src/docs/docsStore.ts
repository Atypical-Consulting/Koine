// Workspace-backed store for the ADR & Notes documentation surface (#147). Reads and writes plain
// Markdown under the opened folder via the existing platform file abstraction (Tauri fs / browser
// File System Access) — no bespoke persistence. ADRs live at `docs/adr/NNNN-title.md`, notes at
// `docs/notes/*.md`, so both travel in git and read fine outside Studio.
//
// Listing non-`.koi` files needs the platform's generic `listDir` (the explorer's `listEntries` is
// `.koi`-only); reads/writes/creates reuse readTextFile/writeTextFile/createFile, which create the
// `docs/adr` folder lazily on first write. The store is pure plumbing over the platform so it
// unit-tests against a mocked host fs.
import type { FsEntry, Platform } from '@/host';
import {
  type Adr,
  adrFilename,
  adrSlug,
  adrTemplate,
  nextAdrNumber,
  parseAdr,
  parseAdrNumberFromFilename,
  renderAdr,
} from '@/docs/adr';

/** Workspace-relative folders the docs surface owns. */
export const ADR_DIR = 'docs/adr';
export const NOTES_DIR = 'docs/notes';

/** An ADR file discovered in the workspace: its host token plus parsed content. */
export interface AdrFile {
  /** Opaque host read/write token. */
  token: string;
  /** File name, e.g. `0003-use-markdown-adrs.md`. */
  name: string;
  /** Sequence number from the filename prefix (authoritative for ordering); 0 when unnumbered. */
  number: number;
  /** The parsed ADR (lenient — never throws; a malformed file degrades to title-from-filename). */
  adr: Adr;
}

/** A note file discovered in the workspace. */
export interface NoteFile {
  /** Opaque host read/write token. */
  token: string;
  /** File name, e.g. `release-process.md`. */
  name: string;
  /** Human title for the list — the filename de-slugged (the body holds the real prose). */
  title: string;
}

/** The ADR/Notes operations the docs panel drives, over one opened workspace folder. */
export interface DocsStore {
  /** Whether the workspace can be written to (false in no-folder mode → create/save disabled). */
  readonly canWrite: boolean;
  /** Every ADR under `docs/adr`, sorted by number then name. `[]` when there is no `docs/adr` yet. */
  listAdrs(): Promise<AdrFile[]>;
  /** Persist `adr` back to its file (re-renders the canonical Markdown). */
  saveAdr(token: string, adr: Adr): Promise<void>;
  /** Create the next-numbered ADR from the template and return it. */
  createAdr(title: string): Promise<AdrFile>;
  /** Every note under `docs/notes`, sorted by name. `[]` when there is no `docs/notes` yet. */
  listNotes(): Promise<NoteFile[]>;
  /** Read a note's raw Markdown. */
  readNote(token: string): Promise<string>;
  /** Persist a note's raw Markdown. */
  saveNote(token: string, markdown: string): Promise<void>;
  /** Create a note `docs/notes/<slug>.md` seeded with a `# Title` heading and return it. */
  createNote(title: string): Promise<NoteFile>;
}

/** A readable title from a note filename: drop `.md`, turn separators into spaces, sentence-case it. */
function noteTitleFromName(name: string): string {
  const base = name.replace(/\.md$/i, '').replace(/[-_]+/g, ' ').trim();
  if (!base) return name;
  return base.charAt(0).toUpperCase() + base.slice(1);
}

/** Only `.md` files (the docs folders may also hold a stray README, an editor swap file, etc.). */
function isMarkdown(entry: FsEntry): boolean {
  return entry.kind === 'file' && entry.name.toLowerCase().endsWith('.md');
}

/** List one docs folder's markdown files, treating a missing folder as empty (not an error). */
async function listMarkdown(platform: Platform, folderToken: string, relPath: string): Promise<FsEntry[]> {
  try {
    return (await platform.listDir(folderToken, relPath)).filter(isMarkdown);
  } catch {
    // The folder doesn't exist yet (or can't be read) — there simply are no docs of this kind.
    return [];
  }
}

/**
 * Create the docs store over an opened workspace folder. Pass `''` as the folder token in no-folder
 * mode: listings return empty and `canWrite` is false, so the panel renders a read-only empty state
 * instead of attempting writes that can't land.
 */
export function createDocsStore(platform: Platform, folderToken: string): DocsStore {
  const canWrite = folderToken !== '';

  function requireWritable(): void {
    if (!canWrite) throw new Error('no workspace folder is open — open a folder to edit docs');
  }

  async function listAdrs(): Promise<AdrFile[]> {
    if (!canWrite) return [];
    const files = await listMarkdown(platform, folderToken, ADR_DIR);
    // The reads are independent, so fan them out rather than awaiting each in turn.
    const out = await Promise.all(
      files.map(async (file): Promise<AdrFile> => {
        const number = parseAdrNumberFromFilename(file.name) ?? 0;
        let adr: Adr;
        try {
          adr = parseAdr(await platform.readTextFile(file.token));
        } catch {
          // Unreadable file — keep it visible (title from filename) rather than dropping it silently.
          adr = { number, title: file.name, status: 'proposed', context: '', decision: '', consequences: '' };
        }
        // The filename number is authoritative for ordering even if the body's heading drifted.
        return { token: file.token, name: file.name, number, adr: { ...adr, number } };
      }),
    );
    out.sort((a, b) => (a.number !== b.number ? a.number - b.number : a.name.localeCompare(b.name)));
    return out;
  }

  async function saveAdr(token: string, adr: Adr): Promise<void> {
    requireWritable();
    await platform.writeTextFile(token, renderAdr(adr));
  }

  async function createAdr(title: string): Promise<AdrFile> {
    requireWritable();
    const existing = await listMarkdown(platform, folderToken, ADR_DIR);
    const number = nextAdrNumber(existing.map((f) => f.name));
    const name = adrFilename(number, title);
    const contents = adrTemplate(title, number);
    const token = await platform.createFile(folderToken, `${ADR_DIR}/${name}`, contents);
    return { token, name, number, adr: parseAdr(contents) };
  }

  async function listNotes(): Promise<NoteFile[]> {
    if (!canWrite) return [];
    const files = await listMarkdown(platform, folderToken, NOTES_DIR);
    return files
      .map((f) => ({ token: f.token, name: f.name, title: noteTitleFromName(f.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  function readNote(token: string): Promise<string> {
    return platform.readTextFile(token);
  }

  async function saveNote(token: string, markdown: string): Promise<void> {
    requireWritable();
    await platform.writeTextFile(token, markdown);
  }

  async function createNote(title: string): Promise<NoteFile> {
    requireWritable();
    const existing = new Set((await listMarkdown(platform, folderToken, NOTES_DIR)).map((f) => f.name.toLowerCase()));
    const base = adrSlug(title, 'note');
    // Avoid clobbering an existing note: base.md, base-2.md, base-3.md, …
    let name = `${base}.md`;
    for (let n = 2; existing.has(name.toLowerCase()); n++) name = `${base}-${n}.md`;
    const token = await platform.createFile(folderToken, `${NOTES_DIR}/${name}`, `# ${title}\n\n`);
    return { token, name, title: noteTitleFromName(name) };
  }

  return { canWrite, listAdrs, saveAdr, createAdr, listNotes, readNote, saveNote, createNote };
}
