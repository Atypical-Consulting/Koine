// The ADR & Notes documentation surface (#147): pure DOM builders for the Docs view, decoupled from
// the workspace fs via a `handlers` object so they unit-test cleanly under happy-dom (mirrors
// glossary.ts). `ide.ts` supplies the handlers (create/save/read through docsStore) and a Markdown
// renderer; this module only builds the DOM and wires clicks. ADRs render as a numbered list with a
// status badge and an inline raw-Markdown editor; notes render lazily (their body is read on open).
// Read views render Markdown (via the injected renderer) into the shared `.koi-md` styling.
import { type Adr, type AdrStatus, parseAdr, renderAdr } from './adr';
import type { AdrFile, NoteFile } from './docsStore';

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

/** Build a plain <button>-styled-as-link with the given class + label. */
function linkButton(className: string, label: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = className;
  b.textContent = label;
  return b;
}

/** The status badge for an ADR (`is-<status>` carries the colour in CSS). */
function statusBadge(status: AdrStatus): HTMLElement {
  const badge = document.createElement('span');
  badge.className = `koi-docs-badge is-${status}`;
  badge.textContent = status;
  return badge;
}

/** A rendered-Markdown block: the injected renderer's HTML (already escaped) under the shared koi-md style. */
function mdBlock(md: string, renderMarkdown: (md: string) => string): HTMLElement {
  const block = document.createElement('div');
  block.className = 'koi-md koi-docs-prose';
  block.innerHTML = renderMarkdown(md.trim() || '—');
  return block;
}

/** A reusable "type a title, Create / Cancel" inline row, hidden until its trigger reveals it. */
function inlineTitleInput(placeholder: string, onSubmit: (title: string) => void, onClose: () => void): HTMLElement {
  const row = document.createElement('div');
  row.className = 'koi-docs-new';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'koi-docs-new-input';
  input.placeholder = placeholder;
  input.setAttribute('aria-label', placeholder);
  const create = linkButton('koi-docs-save', 'Create');
  const cancel = linkButton('koi-docs-cancel', 'Cancel');

  const submit = (): void => {
    const title = input.value.trim();
    if (!title) {
      input.focus();
      return;
    }
    onSubmit(title);
  };
  create.addEventListener('click', submit);
  cancel.addEventListener('click', onClose);
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      submit();
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      onClose();
    }
  });

  const actions = document.createElement('div');
  actions.className = 'koi-docs-actions';
  actions.append(create, cancel);
  row.append(input, actions);
  // Focus after the caller mounts it.
  queueMicrotask(() => input.focus());
  return row;
}

/** A labelled, rendered-Markdown read block for one ADR section (Context / Decision / Consequences). */
function readSection(label: string, body: string, renderMarkdown: (md: string) => string): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'koi-docs-section';
  const h = document.createElement('h4');
  h.textContent = label;
  wrap.append(h, mdBlock(body, renderMarkdown));
  return wrap;
}

/**
 * The expandable detail for one ADR: a rendered-Markdown read view of its sections, with an inline
 * raw-Markdown editor. On save it updates in place (and tells the row to refresh its head via
 * `onSaved`) — the host does not reload the whole panel for an edit.
 */
function adrDetail(
  file: AdrFile,
  handlers: DocsPanelHandlers,
  canWrite: boolean,
  renderMarkdown: (md: string) => string,
  onSaved: (adr: Adr) => void,
): HTMLElement {
  const detail = document.createElement('div');
  detail.className = 'koi-docs-detail';

  const renderRead = (adr: Adr): void => {
    detail.innerHTML = '';
    detail.append(
      readSection('Context', adr.context, renderMarkdown),
      readSection('Decision', adr.decision, renderMarkdown),
      readSection('Consequences', adr.consequences, renderMarkdown),
    );
    if (canWrite) {
      const edit = linkButton('koi-docs-edit', 'Edit');
      edit.setAttribute('aria-label', `Edit ADR ${adr.number}: ${adr.title}`);
      edit.addEventListener('click', () => renderEdit(adr));
      detail.append(edit);
    }
  };

  const renderEdit = (adr: Adr): void => {
    detail.innerHTML = '';
    const textarea = document.createElement('textarea');
    textarea.className = 'koi-docs-input';
    textarea.rows = 16;
    textarea.value = renderAdr(adr);
    textarea.setAttribute('aria-label', `Markdown for ADR ${adr.number}: ${adr.title}`);
    const save = linkButton('koi-docs-save', 'Save');
    const cancel = linkButton('koi-docs-cancel', 'Cancel');
    save.addEventListener('click', () => {
      // The number is owned by the filename, not the body — preserve it across an edit.
      const edited = { ...parseAdr(textarea.value), number: file.number };
      handlers.onSaveAdr(file, edited);
      onSaved(edited); // refresh the row head (title + badge) without a full-panel reload
      renderRead(edited);
    });
    cancel.addEventListener('click', () => renderRead(adr));
    const actions = document.createElement('div');
    actions.className = 'koi-docs-actions';
    actions.append(save, cancel);
    detail.append(textarea, actions);
    textarea.focus();
  };

  renderRead(file.adr);
  return detail;
}

/** One ADR row: `#N · Title` (toggles the detail) + a status badge; both refresh in place on save. */
function adrRow(file: AdrFile, handlers: DocsPanelHandlers, canWrite: boolean, renderMarkdown: (md: string) => string): HTMLElement {
  const row = document.createElement('div');
  row.className = 'koi-docs-item';
  const head = document.createElement('div');
  head.className = 'koi-docs-item-head';

  const name = linkButton('koi-docs-name', `#${file.number} · ${file.adr.title}`);
  name.setAttribute('aria-expanded', 'false');
  let badge = statusBadge(file.adr.status);

  // After an in-place save, keep the row head (title + status badge) in step with the edited ADR so
  // the panel stays accurate without the host reloading and collapsing the open detail.
  const onSaved = (adr: Adr): void => {
    file.adr = adr;
    name.textContent = `#${file.number} · ${adr.title}`;
    const fresh = statusBadge(adr.status);
    badge.replaceWith(fresh);
    badge = fresh;
  };

  let detail: HTMLElement | null = null;
  name.addEventListener('click', () => {
    if (detail) {
      detail.remove();
      detail = null;
      name.setAttribute('aria-expanded', 'false');
      return;
    }
    detail = adrDetail(file, handlers, canWrite, renderMarkdown, onSaved);
    row.append(detail);
    name.setAttribute('aria-expanded', 'true');
  });

  head.append(name, badge);
  row.append(head);
  return row;
}

/** One note row: its title (toggles a lazily-read, rendered-Markdown view + raw editor). */
function noteRow(file: NoteFile, handlers: DocsPanelHandlers, canWrite: boolean, renderMarkdown: (md: string) => string): HTMLElement {
  const row = document.createElement('div');
  row.className = 'koi-docs-item';
  const head = document.createElement('div');
  head.className = 'koi-docs-item-head';
  const name = linkButton('koi-docs-name', file.title);
  name.setAttribute('aria-expanded', 'false');

  let detail: HTMLElement | null = null;
  const close = (): void => {
    detail?.remove();
    detail = null;
    name.setAttribute('aria-expanded', 'false');
  };

  const renderRead = (host: HTMLElement, md: string): void => {
    host.innerHTML = '';
    host.append(mdBlock(md, renderMarkdown));
    if (canWrite) {
      const edit = linkButton('koi-docs-edit', 'Edit');
      edit.setAttribute('aria-label', `Edit note: ${file.title}`);
      edit.addEventListener('click', () => renderEdit(host, md));
      host.append(edit);
    }
  };

  const renderEdit = (host: HTMLElement, md: string): void => {
    host.innerHTML = '';
    const textarea = document.createElement('textarea');
    textarea.className = 'koi-docs-input';
    textarea.rows = 16;
    textarea.value = md;
    textarea.setAttribute('aria-label', `Markdown for note: ${file.title}`);
    const save = linkButton('koi-docs-save', 'Save');
    const cancel = linkButton('koi-docs-cancel', 'Cancel');
    save.addEventListener('click', () => {
      handlers.onSaveNote(file, textarea.value);
      renderRead(host, textarea.value); // update in place; the host does not reload for an edit
    });
    cancel.addEventListener('click', () => renderRead(host, md));
    const actions = document.createElement('div');
    actions.className = 'koi-docs-actions';
    actions.append(save, cancel);
    host.append(textarea, actions);
    textarea.focus();
  };

  name.addEventListener('click', () => {
    if (detail) {
      close();
      return;
    }
    detail = document.createElement('div');
    detail.className = 'koi-docs-detail';
    detail.textContent = 'Loading…';
    row.append(detail);
    name.setAttribute('aria-expanded', 'true');
    const host = detail;
    handlers
      .onReadNote(file)
      .then((md) => renderRead(host, md))
      .catch((e) => {
        host.innerHTML = '';
        const err = document.createElement('p');
        err.className = 'doc-error';
        err.textContent = 'Could not read note: ' + String(e);
        host.append(err);
      });
  });

  head.append(name);
  row.append(head);
  return row;
}

/** A `<section>` with a heading, an optional "New…" trigger, and either rows or an empty state. */
function docsSection(
  title: string,
  newLabel: string,
  canWrite: boolean,
  rows: HTMLElement[],
  emptyText: string,
  onCreate: (title: string) => void,
  newPlaceholder: string,
): HTMLElement {
  const section = document.createElement('section');
  section.className = 'koi-docs-group';

  const header = document.createElement('div');
  header.className = 'koi-docs-group-head';
  const h = document.createElement('h3');
  h.textContent = title;
  header.append(h);

  // The "New…" trigger reveals an inline title input directly under the header (write mode only).
  const newSlot = document.createElement('div');
  if (canWrite) {
    const newBtn = linkButton('koi-docs-new-btn', newLabel);
    const reveal = (): void => {
      newSlot.innerHTML = '';
      newBtn.disabled = true;
      const input = inlineTitleInput(
        newPlaceholder,
        (t) => onCreate(t),
        () => {
          newSlot.innerHTML = '';
          newBtn.disabled = false;
        },
      );
      newSlot.append(input);
    };
    newBtn.addEventListener('click', reveal);
    header.append(newBtn);
  }
  section.append(header, newSlot);

  if (rows.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'koi-docs-empty';
    empty.textContent = emptyText;
    section.append(empty);
  } else {
    for (const r of rows) section.append(r);
  }
  return section;
}

/** Build the Docs panel: an ADR list and a notes list, with create/edit gated by `canWrite`. */
export function renderDocsPanel(data: DocsPanelData, handlers: DocsPanelHandlers): HTMLElement {
  const root = document.createElement('div');
  root.className = 'koi-docs';

  if (!data.canWrite) {
    const banner = document.createElement('p');
    banner.className = 'koi-docs-readonly';
    banner.textContent = 'Open a workspace folder to create and edit ADRs and notes — docs are stored as Markdown under docs/.';
    root.append(banner);
  }

  root.append(
    docsSection(
      'Architecture decisions',
      'New ADR',
      data.canWrite,
      data.adrs.map((f) => adrRow(f, handlers, data.canWrite, data.renderMarkdown)),
      'No architecture decisions yet.',
      handlers.onCreateAdr,
      'ADR title (e.g. Use Markdown ADRs)',
    ),
    docsSection(
      'Notes',
      'New note',
      data.canWrite,
      data.notes.map((f) => noteRow(f, handlers, data.canWrite, data.renderMarkdown)),
      'No notes yet.',
      handlers.onCreateNote,
      'Note title',
    ),
  );

  return root;
}
