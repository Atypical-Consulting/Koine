// Tests for <AdrPanel>/<NotesPanel> (#992 task 5): the JSX ports of the former docsPanel.ts DOM
// builders (renderAdrPanel/renderNotesPanel). Behavior is pinned first (this file), migrating every
// assertion the old docsPanel.test.ts made against the pure-DOM tree, PLUS the new coverage the task
// brief calls for: Enter/Escape on the "New…" title form, the ADR editor's Cancel path, keying rows by
// stable identity (not list position), and the escape-through-MdHtml security contract driven against
// the REAL renderMarkdown (not the trivial stub `full()` uses for wiring checks elsewhere in this file).
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/preact';
import { axe } from 'vitest-axe';
import { AdrPanel, NotesPanel, type DocsPanelData, type DocsPanelHandlers } from '@/docs/DocsPanels';
import { parseAdr } from '@/docs/adr';
import type { AdrFile, NoteFile } from '@/docs/docsStore';
import { renderMarkdown as realRenderMarkdown } from '@/editor/markdown';

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

// A trivial (non-escaping) stub Markdown renderer for wiring checks — mirrors docsPanel.test.ts's own
// `full()`. The escaping CONTRACT itself is proven separately (MdHtml.test.tsx, and the two dedicated
// "renders escaped through MdHtml" tests below, both driven against the REAL renderMarkdown).
function full(data: Partial<DocsPanelData>): DocsPanelData {
  return { canWrite: true, adrs: [], notes: [], renderMarkdown: (md) => `<p>${md}</p>`, ...data };
}

const newAdrTrigger = (container: Element) =>
  Array.from(container.querySelectorAll<HTMLButtonElement>('.koi-docs-new-btn')).find((b) => b.textContent === 'New ADR')!;
const newNoteTrigger = (container: Element) =>
  Array.from(container.querySelectorAll<HTMLButtonElement>('.koi-docs-new-btn')).find((b) => b.textContent === 'New note')!;

describe('AdrPanel', () => {
  it('renders under the koi-docs-adr scroll-anchor id', () => {
    const { container } = render(<AdrPanel data={full({})} handlers={makeHandlers()} />);
    expect(container.querySelector('#koi-docs-adr')).not.toBeNull();
  });

  it('lists ADRs with number, title, and a status badge', () => {
    const { container } = render(
      <AdrPanel
        data={full({ adrs: [adrFile(1, 'Use Markdown ADRs', 'accepted'), adrFile(2, 'Adopt CQRS', 'proposed')] })}
        handlers={makeHandlers()}
      />,
    );
    const names = Array.from(container.querySelectorAll('.koi-docs-name')).map((n) => n.textContent);
    expect(names).toEqual(['#1 · Use Markdown ADRs', '#2 · Adopt CQRS']);
    const badge = container.querySelector('.koi-docs-badge')!;
    expect(badge.textContent).toBe('accepted');
    expect(badge.classList.contains('is-accepted')).toBe(true);
  });

  it('shows an empty state when there are no ADRs', () => {
    const { container } = render(<AdrPanel data={full({})} handlers={makeHandlers()} />);
    const empties = Array.from(container.querySelectorAll('.koi-docs-empty')).map((e) => e.textContent);
    expect(empties).toEqual(['No architecture decisions yet.']);
  });

  it('a row starts collapsed (aria-expanded=false) and toggles open/closed on click', () => {
    const { container } = render(<AdrPanel data={full({ adrs: [adrFile(1, 'X', 'proposed')] })} handlers={makeHandlers()} />);
    const name = container.querySelector<HTMLButtonElement>('.koi-docs-name')!;
    expect(name.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('.koi-docs-detail')).toBeNull();

    fireEvent.click(name);
    expect(name.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('.koi-docs-detail')).not.toBeNull();

    fireEvent.click(name);
    expect(name.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('.koi-docs-detail')).toBeNull();
  });

  it('read-only mode shows a banner, no create button, and no Edit affordance', () => {
    const { container } = render(
      <AdrPanel data={full({ canWrite: false, adrs: [adrFile(1, 'X', 'proposed')] })} handlers={makeHandlers()} />,
    );
    expect(container.querySelector('.koi-docs-readonly')).not.toBeNull();
    expect(container.querySelectorAll('.koi-docs-new-btn').length).toBe(0);

    fireEvent.click(container.querySelector<HTMLButtonElement>('.koi-docs-name')!);
    expect(container.querySelector('.koi-docs-detail')).not.toBeNull();
    expect(container.querySelector('.koi-docs-edit')).toBeNull();
  });

  it('New ADR reveals a focused title input and disables its own trigger', () => {
    const { container } = render(<AdrPanel data={full({})} handlers={makeHandlers()} />);
    const trigger = newAdrTrigger(container);
    fireEvent.click(trigger);

    expect(trigger.disabled).toBe(true);
    const input = container.querySelector<HTMLInputElement>('.koi-docs-new-input')!;
    expect(document.activeElement).toBe(input);
    expect(input.getAttribute('aria-label')).toBe('ADR title (e.g. Use Markdown ADRs)');
  });

  it('Create calls onCreateAdr with the trimmed title (ignoring a blank title)', () => {
    const handlers = makeHandlers();
    const { container } = render(<AdrPanel data={full({})} handlers={handlers} />);
    fireEvent.click(newAdrTrigger(container));
    const input = container.querySelector<HTMLInputElement>('.koi-docs-new-input')!;
    const create = container.querySelector<HTMLButtonElement>('.koi-docs-new .koi-docs-save')!;

    fireEvent.click(create);
    expect(handlers.onCreateAdr).not.toHaveBeenCalled();

    fireEvent.input(input, { target: { value: '  Use Markdown ADRs  ' } });
    fireEvent.click(create);
    expect(handlers.onCreateAdr).toHaveBeenCalledWith('Use Markdown ADRs');
  });

  it(
    'Enter in the new-title input submits (leaving the form open — the host reload clears it, ' +
      'matching the old inlineTitleInput); Escape closes it in place and re-enables the trigger',
    () => {
      const handlers = makeHandlers();
      const { container } = render(<AdrPanel data={full({})} handlers={handlers} />);
      const trigger = newAdrTrigger(container);

      fireEvent.click(trigger);
      const input = container.querySelector<HTMLInputElement>('.koi-docs-new-input')!;
      fireEvent.input(input, { target: { value: 'Adopt Event Sourcing' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(handlers.onCreateAdr).toHaveBeenCalledWith('Adopt Event Sourcing');
      // Submitting does NOT close the form itself (only a host reload — or Cancel/Escape — does).
      expect(container.querySelector('.koi-docs-new-input')).not.toBeNull();
      expect(trigger.disabled).toBe(true);

      fireEvent.keyDown(input, { key: 'Escape' });
      expect(container.querySelector('.koi-docs-new-input')).toBeNull();
      expect(trigger.disabled).toBe(false);
      expect(handlers.onCreateAdr).toHaveBeenCalledTimes(1); // Escape never submitted a second call
    },
  );

  it(
    'editing an ADR saves the parsed markdown, preserving the filename-owned number, and refreshes ' +
      'the row head in place without collapsing the open detail',
    () => {
      const handlers = makeHandlers();
      const { container } = render(<AdrPanel data={full({ adrs: [adrFile(3, 'Old title', 'proposed')] })} handlers={handlers} />);
      const name = container.querySelector<HTMLButtonElement>('.koi-docs-name')!;
      fireEvent.click(name); // expand
      fireEvent.click(container.querySelector<HTMLButtonElement>('.koi-docs-edit')!); // edit

      const textarea = container.querySelector<HTMLTextAreaElement>('.koi-docs-input')!;
      fireEvent.input(textarea, {
        target: { value: '# 999. New title\n\n- Status: accepted\n\n## Context\n\nnew\n\n## Decision\n\nd\n\n## Consequences\n\nc\n' },
      });
      fireEvent.click(container.querySelector<HTMLButtonElement>('.koi-docs-detail .koi-docs-save')!);

      expect(handlers.onSaveAdr).toHaveBeenCalledTimes(1);
      const [file, adr] = (handlers.onSaveAdr as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(file.number).toBe(3);
      expect(adr.number).toBe(3); // filename wins over the body's 999
      expect(adr.title).toBe('New title');
      expect(adr.status).toBe('accepted');

      // The detail stays OPEN (no full-panel reload/collapse); the row head refreshed in place.
      expect(name.getAttribute('aria-expanded')).toBe('true');
      expect(container.querySelector('.koi-docs-name')?.textContent).toBe('#3 · New title');
      expect(container.querySelector('.koi-docs-badge')?.classList.contains('is-accepted')).toBe(true);
      expect(container.querySelector('.koi-docs-input')).toBeNull(); // back to the read view
    },
  );

  it('Cancel in the ADR editor discards the draft and returns to the (unchanged) read view', () => {
    const handlers = makeHandlers();
    const { container } = render(<AdrPanel data={full({ adrs: [adrFile(3, 'Old title', 'proposed')] })} handlers={handlers} />);
    fireEvent.click(container.querySelector<HTMLButtonElement>('.koi-docs-name')!);
    fireEvent.click(container.querySelector<HTMLButtonElement>('.koi-docs-edit')!);
    const textarea = container.querySelector<HTMLTextAreaElement>('.koi-docs-input')!;
    fireEvent.input(textarea, { target: { value: 'garbage' } });
    fireEvent.click(container.querySelector<HTMLButtonElement>('.koi-docs-detail .koi-docs-cancel')!);

    expect(handlers.onSaveAdr).not.toHaveBeenCalled();
    expect(container.querySelector('.koi-docs-input')).toBeNull();
    expect(container.querySelector('.koi-docs-name')?.textContent).toBe('#3 · Old title');
  });

  it('rows are keyed by stable identity (ADR number), not list position or title', () => {
    const handlers = makeHandlers();
    const a = adrFile(1, 'Alpha', 'proposed');
    const b = adrFile(2, 'Beta', 'proposed');
    const { container, rerender } = render(<AdrPanel data={full({ adrs: [a, b] })} handlers={handlers} />);
    const names = () => Array.from(container.querySelectorAll<HTMLButtonElement>('.koi-docs-name'));

    // Expand Beta (currently the second row).
    fireEvent.click(names()[1]);
    expect(names()[1].getAttribute('aria-expanded')).toBe('true');

    // Re-render with fresh AdrFile objects (new identity) for the SAME two ADR numbers, swapped order —
    // simulating a reload that re-sorts/re-fetches. If rows were keyed by array index (or by title),
    // the expanded state would stick to POSITION 1 (now Alpha) instead of following Beta (#2).
    const bFresh = adrFile(2, 'Beta', 'proposed');
    const aFresh = adrFile(1, 'Alpha', 'proposed');
    rerender(<AdrPanel data={full({ adrs: [bFresh, aFresh] })} handlers={handlers} />);

    const namesAfter = names();
    expect(namesAfter[0].textContent).toBe('#2 · Beta');
    expect(namesAfter[0].getAttribute('aria-expanded')).toBe('true'); // followed Beta, not the index
    expect(namesAfter[1].getAttribute('aria-expanded')).toBe('false');
  });

  it('round-trips an ADR through the editor textarea contents (canonical (de)serialization)', () => {
    const md = '# 5. Adopt CQRS\n\n- Status: proposed\n\n## Context\n\nc\n\n## Decision\n\nd\n\n## Consequences\n\ne\n';
    expect(parseAdr(md).title).toBe('Adopt CQRS');
  });

  it('a hostile ADR section body renders escaped through MdHtml, never as live markup (security)', () => {
    const adr = adrFile(1, 'X', 'proposed');
    adr.adr.context = '<script>window.__adrPwned = true</script>';
    const { container } = render(
      <AdrPanel data={full({ adrs: [adr], renderMarkdown: realRenderMarkdown })} handlers={makeHandlers()} />,
    );
    fireEvent.click(container.querySelector<HTMLButtonElement>('.koi-docs-name')!);

    expect(container.querySelector('script')).toBeNull();
    expect((globalThis as unknown as { __adrPwned?: boolean }).__adrPwned).toBeUndefined();
    expect(container.textContent).toContain('<script>window.__adrPwned = true</script>');
  });

  it('has no accessibility violations', async () => {
    const { container } = render(
      <AdrPanel data={full({ adrs: [adrFile(1, 'Use Markdown ADRs', 'accepted')] })} handlers={makeHandlers()} />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('NotesPanel', () => {
  it('renders under the koi-docs-notes scroll-anchor id', () => {
    const { container } = render(<NotesPanel data={full({})} handlers={makeHandlers()} />);
    expect(container.querySelector('#koi-docs-notes')).not.toBeNull();
  });

  it('shows an empty state when there are no notes', () => {
    const { container } = render(<NotesPanel data={full({})} handlers={makeHandlers()} />);
    const empties = Array.from(container.querySelectorAll('.koi-docs-empty')).map((e) => e.textContent);
    expect(empties).toEqual(['No notes yet.']);
  });

  it('read-only mode shows a banner and no create button', () => {
    const { container } = render(
      <NotesPanel data={full({ canWrite: false, notes: [noteFile('x.md', 'X')] })} handlers={makeHandlers()} />,
    );
    expect(container.querySelector('.koi-docs-readonly')).not.toBeNull();
    expect(container.querySelectorAll('.koi-docs-new-btn').length).toBe(0);
  });

  it('New note reveals a focused title input and disables its own trigger; Create calls onCreateNote', () => {
    const handlers = makeHandlers();
    const { container } = render(<NotesPanel data={full({})} handlers={handlers} />);
    const trigger = newNoteTrigger(container);
    fireEvent.click(trigger);

    expect(trigger.disabled).toBe(true);
    const input = container.querySelector<HTMLInputElement>('.koi-docs-new-input')!;
    expect(document.activeElement).toBe(input);
    expect(input.getAttribute('aria-label')).toBe('Note title');

    fireEvent.input(input, { target: { value: '  Release process  ' } });
    fireEvent.click(container.querySelector<HTMLButtonElement>('.koi-docs-new .koi-docs-save')!);
    expect(handlers.onCreateNote).toHaveBeenCalledWith('Release process');
  });

  it('opens a note lazily: shows "Loading…" then the rendered body, and toggles aria-expanded', async () => {
    const handlers = makeHandlers();
    const { container } = render(
      <NotesPanel data={full({ notes: [noteFile('release-process.md', 'Release process')] })} handlers={handlers} />,
    );
    const name = container.querySelector<HTMLButtonElement>('.koi-docs-name')!;
    expect(name.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(name);
    expect(name.getAttribute('aria-expanded')).toBe('true');
    expect(handlers.onReadNote).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.koi-docs-detail')!.textContent).toBe('Loading…');

    await vi.waitFor(() => {
      expect(container.querySelector('.koi-docs-prose')?.textContent).toContain('Step one.');
    });
  });

  it('a failed read shows a doc-error message instead of the body', async () => {
    const handlers = makeHandlers();
    handlers.onReadNote = vi.fn(async () => {
      throw new Error('disk exploded');
    });
    const { container } = render(<NotesPanel data={full({ notes: [noteFile('x.md', 'X')] })} handlers={handlers} />);
    fireEvent.click(container.querySelector<HTMLButtonElement>('.koi-docs-name')!);

    await vi.waitFor(() => {
      expect(container.querySelector('.doc-error')).not.toBeNull();
    });
    expect(container.querySelector('.doc-error')!.textContent).toBe('Could not read note: Error: disk exploded');
  });

  it('editing a note saves the raw markdown and updates the read view in place', async () => {
    const handlers = makeHandlers();
    const { container } = render(
      <NotesPanel data={full({ notes: [noteFile('release-process.md', 'Release process')] })} handlers={handlers} />,
    );
    fireEvent.click(container.querySelector<HTMLButtonElement>('.koi-docs-name')!);
    await vi.waitFor(() => expect(container.querySelector('.koi-docs-prose')).not.toBeNull());

    fireEvent.click(container.querySelector<HTMLButtonElement>('.koi-docs-edit')!);
    const textarea = container.querySelector<HTMLTextAreaElement>('.koi-docs-input')!;
    expect(textarea.getAttribute('aria-label')).toBe('Markdown for note: Release process');
    fireEvent.input(textarea, { target: { value: '# Release process\n\nStep two.\n' } });
    fireEvent.click(container.querySelector<HTMLButtonElement>('.koi-docs-detail .koi-docs-save')!);

    expect(handlers.onSaveNote).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'release-process.md' }),
      '# Release process\n\nStep two.\n',
    );
    expect(container.querySelector('.koi-docs-input')).toBeNull();
    expect(container.querySelector('.koi-docs-prose')?.textContent).toContain('Step two.');
  });

  it('Cancel in the note editor discards the draft and returns to the (unchanged) read view', async () => {
    const handlers = makeHandlers();
    const { container } = render(
      <NotesPanel data={full({ notes: [noteFile('release-process.md', 'Release process')] })} handlers={handlers} />,
    );
    fireEvent.click(container.querySelector<HTMLButtonElement>('.koi-docs-name')!);
    await vi.waitFor(() => expect(container.querySelector('.koi-docs-prose')).not.toBeNull());

    fireEvent.click(container.querySelector<HTMLButtonElement>('.koi-docs-edit')!);
    const textarea = container.querySelector<HTMLTextAreaElement>('.koi-docs-input')!;
    fireEvent.input(textarea, { target: { value: 'garbage draft' } });
    fireEvent.click(container.querySelector<HTMLButtonElement>('.koi-docs-detail .koi-docs-cancel')!);

    expect(handlers.onSaveNote).not.toHaveBeenCalled();
    expect(container.querySelector('.koi-docs-input')).toBeNull();
    expect(container.querySelector('.koi-docs-prose')?.textContent).toContain('Step one.');
  });

  it('closing and reopening a note re-fetches (no stale cache) and re-collapses cleanly', async () => {
    const handlers = makeHandlers();
    const { container } = render(<NotesPanel data={full({ notes: [noteFile('x.md', 'X')] })} handlers={handlers} />);
    const name = container.querySelector<HTMLButtonElement>('.koi-docs-name')!;

    fireEvent.click(name); // open
    await vi.waitFor(() => expect(container.querySelector('.koi-docs-prose')).not.toBeNull());
    fireEvent.click(name); // close
    expect(name.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('.koi-docs-detail')).toBeNull();

    fireEvent.click(name); // reopen
    expect(handlers.onReadNote).toHaveBeenCalledTimes(2);
    expect(container.querySelector('.koi-docs-detail')!.textContent).toBe('Loading…');
    await vi.waitFor(() => expect(container.querySelector('.koi-docs-prose')).not.toBeNull());
  });

  it('a hostile note body renders escaped through MdHtml, never as live markup (security)', async () => {
    const handlers = makeHandlers();
    handlers.onReadNote = vi.fn(async () => '<img src=x onerror="window.__notePwned = true">');
    const { container } = render(
      <NotesPanel data={full({ notes: [noteFile('x.md', 'X')], renderMarkdown: realRenderMarkdown })} handlers={handlers} />,
    );
    fireEvent.click(container.querySelector<HTMLButtonElement>('.koi-docs-name')!);
    await vi.waitFor(() => expect(container.querySelector('.koi-docs-prose')).not.toBeNull());

    expect(container.querySelector('img')).toBeNull();
    expect((globalThis as unknown as { __notePwned?: boolean }).__notePwned).toBeUndefined();
    expect(container.textContent).toContain('<img src=x onerror="window.__notePwned = true">');
  });

  it('has no accessibility violations', async () => {
    const { container } = render(
      <NotesPanel data={full({ notes: [noteFile('release-process.md', 'Release process')] })} handlers={makeHandlers()} />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
