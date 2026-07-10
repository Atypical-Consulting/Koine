import { useEffect, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { type Adr, type AdrStatus, parseAdr, renderAdr } from '@/docs/adr';
import type { AdrFile, NoteFile } from '@/docs/docsStore';
import { MdHtml } from '@/docs/MdHtml';
import { useCommittableField } from '@/shared/useCommittableField';

// The ADR & Notes documentation surface (#147, #193) as real JSX (#992 task 5) — replaces the retired
// `docsPanel.ts` pure-DOM builders (`renderAdrPanel`/`renderNotesPanel`) with `<AdrPanel>`/`<NotesPanel>`,
// mounted by `surfaceLoaders.tsx`'s `loadAdr`/`loadNotes` via the shared `renderPanel` unmount-first
// helper (the same one `GlossaryPanel`/`EventsPanel`/`RelationshipsPanel` use). `docsPanel.test.ts`'s
// assertions live on in `DocsPanels.test.tsx`, now driven through Preact/testing-library instead of a
// hand-built DOM tree. Every rendered ADR/note body routes through the single `MdHtml` component
// (`docs/MdHtml.tsx`) — the one sanctioned `dangerouslySetInnerHTML` site for this conversion; nothing in
// this file writes `innerHTML` directly (the old `mdBlock` builder is gone).
//
// `DocsPanelData`/`DocsPanelHandlers` are unchanged as the props contract (moved verbatim from
// `docsPanel.ts`) so the controller's wiring needs no reshaping, only a different render target.

export interface DocsPanelData {
  /** Whether the workspace can be written to — gates the create/edit affordances. */
  canWrite: boolean;
  adrs: AdrFile[];
  notes: NoteFile[];
  /** Render a Markdown string to a (sanitized) HTML string for the read views. */
  renderMarkdown: (md: string) => string;
}

export interface DocsPanelHandlers {
  /** Create a new ADR from the template with this title (then the panel is reloaded by the host). */
  onCreateAdr(title: string): void;
  /** Persist an edited ADR back to its file. */
  onSaveAdr(file: AdrFile, adr: Adr): void;
  /** Create a new note with this title. */
  onCreateNote(title: string): void;
  /** Read a note's raw Markdown (lazily, on open). */
  onReadNote(file: NoteFile): Promise<string>;
  /** Persist an edited note's raw Markdown. */
  onSaveNote(file: NoteFile, markdown: string): void;
}

/** The shared `.koi-docs` shell + an optional read-only banner — the common frame for both pages. */
function DocsRoot(props: { canWrite: boolean; readonlyText: string; children: ComponentChildren }) {
  return (
    <div class="koi-docs">
      {!props.canWrite && <p class="koi-docs-readonly">{props.readonlyText}</p>}
      {props.children}
    </div>
  );
}

/**
 * A reusable "type a title, Create / Cancel" inline row, hidden until its trigger reveals it (owned by
 * `DocsSection` below). Focuses its input on mount (mirrors the old `inlineTitleInput`'s
 * `queueMicrotask`-deferred focus, here a plain mount effect since Preact has already committed the DOM
 * by the time effects run). Mirrors the old `inlineTitleInput`'s asymmetry exactly: Create/Enter only
 * calls `onSubmit` — it does NOT close the form itself (the original relied on the caller's create
 * handler reloading the whole panel, which unmounts this tree along with it); only Cancel/Escape closes
 * it in place via `onClose`.
 */
function NewTitleForm(props: { placeholder: string; onSubmit: (title: string) => void; onClose: () => void }) {
  const [title, setTitle] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = (): void => {
    const trimmed = title.trim();
    if (!trimmed) {
      inputRef.current?.focus();
      return;
    }
    props.onSubmit(trimmed);
  };

  return (
    <div class="koi-docs-new">
      <input
        ref={inputRef}
        type="text"
        class="koi-docs-new-input"
        placeholder={props.placeholder}
        aria-label={props.placeholder}
        value={title}
        onInput={(e) => setTitle((e.currentTarget as HTMLInputElement).value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            submit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            props.onClose();
          }
        }}
      />
      <div class="koi-docs-actions">
        <button type="button" class="koi-docs-save" onClick={submit}>
          Create
        </button>
        <button type="button" class="koi-docs-cancel" onClick={props.onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** A `<section>` with a heading, an optional "New…" trigger, and either its rows or an empty state. The
 *  `id` is the scroll anchor the rail's Documentation links (ADR / Notes) target. */
function DocsSection(props: {
  id: string;
  title: string;
  newLabel: string;
  canWrite: boolean;
  itemCount: number;
  emptyText: string;
  newPlaceholder: string;
  onCreate: (title: string) => void;
  children: ComponentChildren;
}) {
  const [creating, setCreating] = useState(false);

  return (
    <section class="koi-docs-group" id={props.id}>
      <div class="koi-docs-group-head">
        <h3>{props.title}</h3>
        {props.canWrite && (
          <button type="button" class="koi-docs-new-btn" disabled={creating} onClick={() => setCreating(true)}>
            {props.newLabel}
          </button>
        )}
      </div>
      {creating && (
        <NewTitleForm
          placeholder={props.newPlaceholder}
          // Matches the old inlineTitleInput exactly: submitting does NOT close the form itself — in
          // production the create handler reloads the whole panel (surfaceLoaders.tsx's docsHandlers),
          // which unmounts this tree along with it. Only Cancel/Escape closes it in place.
          onSubmit={props.onCreate}
          onClose={() => setCreating(false)}
        />
      )}
      {props.itemCount === 0 ? <p class="koi-docs-empty">{props.emptyText}</p> : props.children}
    </section>
  );
}

/** The status badge for an ADR (`is-<status>` carries the colour in CSS). */
function StatusBadge(props: { status: AdrStatus }) {
  return <span class={`koi-docs-badge is-${props.status}`}>{props.status}</span>;
}

/** A labelled, rendered-Markdown read block for one ADR section (Context / Decision / Consequences). */
function AdrReadSection(props: { label: string; body: string; renderMarkdown: (md: string) => string }) {
  return (
    <div class="koi-docs-section">
      <h4>{props.label}</h4>
      <MdHtml md={props.body} render={props.renderMarkdown} />
    </div>
  );
}

/**
 * One ADR row: `#N · Title` (toggles the detail) + a status badge, both refreshing in place on save — no
 * host reload. `adr` is local state seeded from `file.adr`: editing produces a fresh parsed `Adr` (with
 * the FILENAME-owned `number` preserved, never the body's own heading number) that both persists via
 * `onSaveAdr` and updates this row's own read view immediately. The editor's draft/editing/revert
 * wiring is a `useCommittableField` over the canonical `renderAdr(adr)` text (see
 * `@/shared/useCommittableField` for the commit/revert contract).
 */
function AdrRow(props: {
  file: AdrFile;
  handlers: DocsPanelHandlers;
  canWrite: boolean;
  renderMarkdown: (md: string) => string;
}) {
  const { file, handlers, canWrite, renderMarkdown } = props;
  const [open, setOpen] = useState(false);
  const [adr, setAdr] = useState<Adr>(file.adr);
  const { editing, draft, setDraft, openEditor, commit: save, cancel: cancelEdit } = useCommittableField({
    committedValue: renderAdr(adr),
    onCommit: (next) => {
      // The number is owned by the filename, not the body — preserve it across an edit.
      const edited = { ...parseAdr(next), number: file.number };
      handlers.onSaveAdr(file, edited);
      setAdr(edited); // refresh the row head (title + badge) without a full-panel reload
    },
  });
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (editing) textareaRef.current?.focus();
  }, [editing]);

  return (
    <div class="koi-docs-item">
      <div class="koi-docs-item-head">
        <button
          type="button"
          class="koi-docs-name"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          #{file.number} · {adr.title}
        </button>
        <StatusBadge status={adr.status} />
      </div>
      {open && (
        <div class="koi-docs-detail">
          {editing ? (
            <>
              <textarea
                ref={textareaRef}
                class="koi-docs-input"
                rows={16}
                aria-label={`Markdown for ADR ${file.number}: ${adr.title}`}
                value={draft}
                onInput={(e) => setDraft((e.currentTarget as HTMLTextAreaElement).value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    cancelEdit(); // the hook's cancel: revert-and-close, same path as the Cancel button
                  }
                }}
              />
              <div class="koi-docs-actions">
                <button type="button" class="koi-docs-save" onClick={save}>
                  Save
                </button>
                <button type="button" class="koi-docs-cancel" onClick={cancelEdit}>
                  Cancel
                </button>
              </div>
            </>
          ) : (
            <>
              <AdrReadSection label="Context" body={adr.context} renderMarkdown={renderMarkdown} />
              <AdrReadSection label="Decision" body={adr.decision} renderMarkdown={renderMarkdown} />
              <AdrReadSection label="Consequences" body={adr.consequences} renderMarkdown={renderMarkdown} />
              {canWrite && (
                <button
                  type="button"
                  class="koi-docs-edit"
                  aria-label={`Edit ADR ${file.number}: ${adr.title}`}
                  onClick={openEditor}
                >
                  Edit
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** The Decisions page: the ADR list, with create/edit gated by `canWrite`. (Split from the former
 *  combined Docs panel, #174 — Notes are their own page; see {@link NotesPanel}.) Rows are keyed on the
 *  file's `token` (the workspace path — an opaque host read/write token, unique per file) — never on
 *  list position, title, or the ADR's own `number` — so a reload that re-sorts/re-fetches the list
 *  doesn't leak one row's open/edit state onto another (#992 review precedent set by PropertiesPanel's
 *  Name/Description fields, task 4). `number` alone is NOT safe to key on: `docsStore.ts`'s `listAdrs`
 *  falls back to `parseAdrNumberFromFilename(file.name) ?? 0` for any ADR file whose name lacks a
 *  numeric prefix, so two such files collide on `number: 0` and would otherwise conflate their
 *  expanded/editing state (final #992 review, Finding 2). */
export function AdrPanel(props: { data: DocsPanelData; handlers: DocsPanelHandlers }) {
  const { data, handlers } = props;
  return (
    <DocsRoot canWrite={data.canWrite} readonlyText="Open a workspace folder to create and edit ADRs — stored as Markdown under docs/.">
      <DocsSection
        id="koi-docs-adr"
        title="Architecture decisions"
        newLabel="New ADR"
        canWrite={data.canWrite}
        itemCount={data.adrs.length}
        emptyText="No architecture decisions yet."
        newPlaceholder="ADR title (e.g. Use Markdown ADRs)"
        onCreate={handlers.onCreateAdr}
      >
        {data.adrs.map((file) => (
          <AdrRow key={file.token} file={file} handlers={handlers} canWrite={data.canWrite} renderMarkdown={data.renderMarkdown} />
        ))}
      </DocsSection>
    </DocsRoot>
  );
}

type NoteLoadStatus = 'idle' | 'loading' | 'loaded' | 'error';

/**
 * One note row: its title (toggles a lazily-read, rendered-Markdown view + raw editor). Every OPEN
 * re-fetches (closing drops the loaded body, mirroring the old `noteRow`'s `detail = null` / fresh
 * `onReadNote` call on each open — no cross-open cache). `requestId` guards a superseded fetch (a close
 * immediately followed by a reopen, or a fast double-click) from landing after a newer one already did.
 * The editor's draft/editing/revert wiring is a `useCommittableField` over the loaded `body` (see
 * `@/shared/useCommittableField` for the commit/revert contract — including how the asynchronously
 * arriving body refreshes the idle draft so Edit always opens on the freshly loaded text).
 */
function NoteRow(props: {
  file: NoteFile;
  handlers: DocsPanelHandlers;
  canWrite: boolean;
  renderMarkdown: (md: string) => string;
}) {
  const { file, handlers, canWrite, renderMarkdown } = props;
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<NoteLoadStatus>('idle');
  const [body, setBody] = useState('');
  const [errorText, setErrorText] = useState('');
  const { editing, draft, setDraft, openEditor, commit: save, cancel: cancelEdit } = useCommittableField({
    committedValue: body,
    onCommit: (next) => {
      handlers.onSaveNote(file, next);
      setBody(next); // update in place; the host does not reload for an edit
    },
  });
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const requestId = useRef(0);
  const alive = useRef(true);
  useEffect(() => () => {
    alive.current = false;
  }, []);

  useEffect(() => {
    if (editing) textareaRef.current?.focus();
  }, [editing]);

  const toggle = (): void => {
    if (open) {
      setOpen(false);
      cancelEdit(); // closing always leaves edit mode (matches the old explicit setEditing(false))
      setStatus('idle');
      return;
    }
    // No edit-mode reset needed here: the close branch above (the only way back to closed) already
    // cancelled, so `editing` is structurally false when reopening.
    setOpen(true);
    setStatus('loading');
    const id = ++requestId.current;
    handlers
      .onReadNote(file)
      .then((md) => {
        if (!alive.current || id !== requestId.current) return; // superseded by a close/reopen, or unmounted
        setBody(md);
        setStatus('loaded');
      })
      .catch((e) => {
        if (!alive.current || id !== requestId.current) return;
        setErrorText('Could not read note: ' + String(e));
        setStatus('error');
      });
  };

  return (
    <div class="koi-docs-item">
      <div class="koi-docs-item-head">
        <button type="button" class="koi-docs-name" aria-expanded={open} onClick={toggle}>
          {file.title}
        </button>
      </div>
      {open && (
        <div class="koi-docs-detail">
          {status === 'loading' && 'Loading…'}
          {status === 'error' && <p class="doc-error">{errorText}</p>}
          {status === 'loaded' &&
            (editing ? (
              <>
                <textarea
                  ref={textareaRef}
                  class="koi-docs-input"
                  rows={16}
                  aria-label={`Markdown for note: ${file.title}`}
                  value={draft}
                  onInput={(e) => setDraft((e.currentTarget as HTMLTextAreaElement).value)}
                />
                <div class="koi-docs-actions">
                  <button type="button" class="koi-docs-save" onClick={save}>
                    Save
                  </button>
                  <button type="button" class="koi-docs-cancel" onClick={cancelEdit}>
                    Cancel
                  </button>
                </div>
              </>
            ) : (
              <>
                <MdHtml md={body} render={renderMarkdown} />
                {canWrite && (
                  <button type="button" class="koi-docs-edit" aria-label={`Edit note: ${file.title}`} onClick={openEditor}>
                    Edit
                  </button>
                )}
              </>
            ))}
        </div>
      )}
    </div>
  );
}

/** The Notes page: the free-form notes list, with create/edit gated by `canWrite`. Rows are keyed on the
 *  note's own workspace `token` (stable identity) — never on title or list position. */
export function NotesPanel(props: { data: DocsPanelData; handlers: DocsPanelHandlers }) {
  const { data, handlers } = props;
  return (
    <DocsRoot canWrite={data.canWrite} readonlyText="Open a workspace folder to create and edit notes — stored as Markdown under docs/.">
      <DocsSection
        id="koi-docs-notes"
        title="Notes"
        newLabel="New note"
        canWrite={data.canWrite}
        itemCount={data.notes.length}
        emptyText="No notes yet."
        newPlaceholder="Note title"
        onCreate={handlers.onCreateNote}
      >
        {data.notes.map((file) => (
          <NoteRow key={file.token} file={file} handlers={handlers} canWrite={data.canWrite} renderMarkdown={data.renderMarkdown} />
        ))}
      </DocsSection>
    </DocsRoot>
  );
}
