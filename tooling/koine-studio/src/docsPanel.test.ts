import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseAdr } from './adr';
import type { AdrFile, NoteFile } from './docsStore';
import { renderAdrPanel, renderNotesPanel, type DocsPanelData, type DocsPanelHandlers } from './docsPanel';

function adrFile(number: number, title: string, status: 'proposed' | 'accepted' | 'superseded'): AdrFile {
  return {
    token: `WS/docs/adr/${String(number).padStart(4, '0')}-x.md`,
    name: `${String(number).padStart(4, '0')}-x.md`,
    number,
    adr: { number, title, status, context: 'ctx', decision: 'dec', consequences: 'con' },
  };
}

function noteFile(name: string, title: string): NoteFile {
  return { token: `WS/docs/notes/${name}`, name, title };
}

function makeHandlers(): DocsPanelHandlers {
  return {
    onCreateAdr: vi.fn(),
    onSaveAdr: vi.fn(),
    onCreateNote: vi.fn(),
    onReadNote: vi.fn(async () => '# Release process\n\nStep one.\n'),
    onSaveNote: vi.fn(),
  };
}

function full(data: Partial<DocsPanelData>): DocsPanelData {
  // A trivial Markdown renderer for tests: wrap in a <p> so the read block has rendered HTML.
  return { canWrite: true, adrs: [], notes: [], renderMarkdown: (md) => `<p>${md}</p>`, ...data };
}

/** Mount the Decisions (ADR) page. */
function mount(data: Partial<DocsPanelData>, handlers: DocsPanelHandlers): HTMLElement {
  const el = renderAdrPanel(full(data), handlers);
  document.body.append(el);
  return el;
}

/** Mount the Notes page. */
function mountNotes(data: Partial<DocsPanelData>, handlers: DocsPanelHandlers): HTMLElement {
  const el = renderNotesPanel(full(data), handlers);
  document.body.append(el);
  return el;
}

describe('docsPanel', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('lists ADRs with number, title, and a status badge', () => {
    const el = mount({ adrs: [adrFile(1, 'Use Markdown ADRs', 'accepted'), adrFile(2, 'Adopt CQRS', 'proposed')] }, makeHandlers());
    const names = Array.from(el.querySelectorAll('.koi-docs-name')).map((n) => n.textContent);
    expect(names).toEqual(['#1 · Use Markdown ADRs', '#2 · Adopt CQRS']);
    const badge = el.querySelector('.koi-docs-badge')!;
    expect(badge.textContent).toBe('accepted');
    expect(badge.classList.contains('is-accepted')).toBe(true);
  });

  it('shows an empty state on the Decisions page when there are no ADRs', () => {
    const el = mount({}, makeHandlers());
    const empties = Array.from(el.querySelectorAll('.koi-docs-empty')).map((e) => e.textContent);
    expect(empties).toEqual(['No architecture decisions yet.']);
  });

  it('shows an empty state on the Notes page when there are no notes', () => {
    const el = mountNotes({}, makeHandlers());
    const empties = Array.from(el.querySelectorAll('.koi-docs-empty')).map((e) => e.textContent);
    expect(empties).toEqual(['No notes yet.']);
  });

  it('read-only mode shows a banner, no create buttons, and no Edit affordance', () => {
    const el = mount({ canWrite: false, adrs: [adrFile(1, 'X', 'proposed')] }, makeHandlers());
    expect(el.querySelector('.koi-docs-readonly')).not.toBeNull();
    expect(el.querySelectorAll('.koi-docs-new-btn').length).toBe(0);

    // Expanding the ADR shows its sections but offers no Edit button.
    (el.querySelector('.koi-docs-name') as HTMLButtonElement).click();
    expect(el.querySelector('.koi-docs-detail')).not.toBeNull();
    expect(Array.from(el.querySelectorAll('.koi-docs-edit')).map((b) => b.textContent)).not.toContain('Edit');
  });

  it('New ADR reveals a title input and Create calls the handler (ignoring a blank title)', () => {
    const handlers = makeHandlers();
    const el = mount({}, handlers);
    const newBtn = Array.from(el.querySelectorAll<HTMLButtonElement>('.koi-docs-new-btn')).find((b) => b.textContent === 'New ADR')!;
    newBtn.click();
    const input = el.querySelector<HTMLInputElement>('.koi-docs-new-input')!;
    const create = el.querySelector<HTMLButtonElement>('.koi-docs-new .koi-docs-save')!;

    // Blank → no-op.
    create.click();
    expect(handlers.onCreateAdr).not.toHaveBeenCalled();

    input.value = '  Use Markdown ADRs  ';
    create.click();
    expect(handlers.onCreateAdr).toHaveBeenCalledWith('Use Markdown ADRs');
  });

  it('editing an ADR saves the parsed markdown (preserving the filename number)', () => {
    const handlers = makeHandlers();
    const el = mount({ adrs: [adrFile(3, 'Old title', 'proposed')] }, handlers);
    (el.querySelector('.koi-docs-name') as HTMLButtonElement).click(); // expand
    (el.querySelector('.koi-docs-edit') as HTMLButtonElement).click(); // edit

    const textarea = el.querySelector<HTMLTextAreaElement>('.koi-docs-input')!;
    textarea.value = '# 999. New title\n\n- Status: accepted\n\n## Context\n\nnew\n\n## Decision\n\nd\n\n## Consequences\n\nc\n';
    (el.querySelector('.koi-docs-detail .koi-docs-save') as HTMLButtonElement).click();

    expect(handlers.onSaveAdr).toHaveBeenCalledTimes(1);
    const [file, adr] = (handlers.onSaveAdr as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(file.number).toBe(3);
    expect(adr.number).toBe(3); // filename wins over the body's 999
    expect(adr.title).toBe('New title');
    expect(adr.status).toBe('accepted');

    // The row head refreshes in place (no host reload): the name + status badge track the edit.
    expect(el.querySelector('.koi-docs-name')?.textContent).toBe('#3 · New title');
    expect(el.querySelector('.koi-docs-badge')?.classList.contains('is-accepted')).toBe(true);
  });

  it('opens a note lazily and saves edited markdown', async () => {
    const handlers = makeHandlers();
    const el = mountNotes({ notes: [noteFile('release-process.md', 'Release process')] }, handlers);
    (el.querySelector('.koi-docs-name') as HTMLButtonElement).click();
    expect(handlers.onReadNote).toHaveBeenCalledTimes(1);

    await vi.waitFor(() => {
      expect(el.querySelector('.koi-docs-prose')?.textContent).toContain('Step one.');
    });

    (el.querySelector('.koi-docs-edit') as HTMLButtonElement).click();
    const textarea = el.querySelector<HTMLTextAreaElement>('.koi-docs-input')!;
    textarea.value = '# Release process\n\nStep two.\n';
    (el.querySelector('.koi-docs-detail .koi-docs-save') as HTMLButtonElement).click();
    expect(handlers.onSaveNote).toHaveBeenCalledWith(expect.objectContaining({ name: 'release-process.md' }), '# Release process\n\nStep two.\n');
  });
});

// A guard that the panel only ever needs the canonical ADR (de)serialization for its editors.
it('round-trips an ADR through the editor textarea contents', () => {
  const md = '# 5. Adopt CQRS\n\n- Status: proposed\n\n## Context\n\nc\n\n## Decision\n\nd\n\n## Consequences\n\ne\n';
  expect(parseAdr(md).title).toBe('Adopt CQRS');
});
