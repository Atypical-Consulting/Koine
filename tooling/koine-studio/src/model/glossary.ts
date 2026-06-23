// The ubiquitous-language glossary editor (#67): pure DOM builders for the glossary tab, decoupled
// from the LSP/editor wiring via a `handlers` object so they unit-test cleanly under happy-dom.
// `ide.ts` supplies the handlers (jump-to-source via the editor, persist via koine/setDoc).
import type { GlossaryEntry, GlossaryModel, Range } from '@/lsp/lsp';

export interface GlossaryHandlers {
  /** Jump the editor to a declaration's name range. */
  onGoto(range: Range): void;
  /** Persist a description (write the `///` doc comment back to source). */
  onSave(entry: GlossaryEntry, text: string): void;
}

/** Documentation coverage over the glossary entries (an entry counts as documented iff its doc is non-blank). */
export function coverage(entries: GlossaryEntry[]): { documented: number; total: number; pct: number } {
  const documented = entries.filter((e) => e.doc != null && e.doc.trim().length > 0).length;
  const total = entries.length;
  const pct = total === 0 ? 0 : Math.round((documented / total) * 100);
  return { documented, total, pct };
}

/** Group entries by owning context, preserving declaration order of both contexts and entries. */
export function groupByContext(entries: GlossaryEntry[]): { context: string; entries: GlossaryEntry[] }[] {
  const groups: { context: string; entries: GlossaryEntry[] }[] = [];
  for (const e of entries) {
    let g = groups.find((x) => x.context === e.context);
    if (!g) {
      g = { context: e.context, entries: [] };
      groups.push(g);
    }
    g.entries.push(e);
  }
  return groups;
}

/** Builds the glossary editor: a coverage gauge, then concepts grouped by bounded context. */
export function renderGlossary(model: GlossaryModel, handlers: GlossaryHandlers): HTMLElement {
  const root = document.createElement('div');
  root.className = 'koi-gloss';

  const { documented, total, pct } = coverage(model.entries);
  const gauge = document.createElement('div');
  gauge.className = 'koi-gloss-coverage';
  const label = document.createElement('span');
  label.innerHTML = `<strong>Ubiquitous language</strong>`;
  const count = document.createElement('span');
  count.className = 'muted';
  count.textContent = `${documented} / ${total} documented · ${pct}%`;
  gauge.append(label, count);
  const bar = document.createElement('div');
  bar.className = 'koi-gloss-bar';
  const fill = document.createElement('div');
  fill.className = 'koi-gloss-bar-fill';
  fill.style.width = `${pct}%`;
  bar.appendChild(fill);
  root.append(gauge, bar);

  for (const g of groupByContext(model.entries)) {
    const section = document.createElement('section');
    section.className = 'koi-gloss-ctx';
    const h = document.createElement('h3');
    h.textContent = g.context;
    section.appendChild(h);
    // The context's own entry first (so its description can be authored), then its types.
    for (const entry of g.entries.filter((e) => e.kind === 'context')) {
      section.appendChild(renderEntry(entry, handlers));
    }
    for (const entry of g.entries.filter((e) => e.kind !== 'context')) {
      section.appendChild(renderEntry(entry, handlers));
    }
    root.appendChild(section);
  }

  return root;
}

/** One glossary row: name (jumps to source) + kind badge + description with an inline editor. */
function renderEntry(entry: GlossaryEntry, handlers: GlossaryHandlers): HTMLElement {
  const row = document.createElement('div');
  row.className = 'koi-gloss-entry';

  const head = document.createElement('div');
  head.className = 'koi-gloss-entry-head';
  const name = document.createElement('button');
  name.type = 'button';
  name.className = 'koi-gloss-name';
  name.textContent = entry.name;
  name.title = 'Go to definition';
  name.setAttribute('aria-label', `Go to definition: ${entry.name}`);
  name.addEventListener('click', () => handlers.onGoto(entry.nameRange));
  const kind = document.createElement('span');
  kind.className = 'koi-gloss-kind';
  kind.textContent = entry.kind;
  head.append(name, kind);

  const body = document.createElement('div');
  body.className = 'koi-gloss-body';
  row.append(head, body);
  renderDescription(entry, body, handlers);
  return row;
}

/** Renders the read view of a description (or a "needs description" prompt) with an edit button. */
function renderDescription(entry: GlossaryEntry, body: HTMLElement, handlers: GlossaryHandlers): void {
  body.innerHTML = '';
  const hasDoc = entry.doc != null && entry.doc.trim().length > 0;
  const text = document.createElement('p');
  text.className = hasDoc ? 'koi-gloss-doc' : 'koi-gloss-needsdoc';
  text.textContent = hasDoc ? entry.doc!.trim() : 'Needs description';

  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.className = 'koi-gloss-edit';
  editBtn.textContent = hasDoc ? 'Edit' : 'Add description';
  editBtn.setAttribute('aria-label', `${hasDoc ? 'Edit' : 'Add'} description for ${entry.name}`);
  editBtn.addEventListener('click', () => openDescriptionEditor(entry, body, handlers));

  body.append(text, editBtn);
}

/** Opens the inline prose editor for a description; Save persists via the handler and closes. */
function openDescriptionEditor(entry: GlossaryEntry, body: HTMLElement, handlers: GlossaryHandlers): void {
  body.innerHTML = '';
  const input = document.createElement('textarea');
  input.className = 'koi-gloss-input';
  input.rows = 2;
  input.value = entry.doc?.trim() ?? '';
  input.placeholder = `Describe ${entry.name} in plain language…`;
  input.setAttribute('aria-label', `Description for ${entry.name}`);

  // Persist, then close the inline editor optimistically. The parent reloads the tab so coverage
  // and the server-canonical doc text refresh on the next render.
  const commit = (): void => {
    handlers.onSave(entry, input.value);
    renderDescription({ ...entry, doc: input.value.trim() || null }, body, handlers);
  };

  const actions = document.createElement('div');
  actions.className = 'koi-gloss-actions';
  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'koi-gloss-save';
  save.textContent = 'Save';
  save.setAttribute('aria-label', `Save description for ${entry.name}`);
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'koi-gloss-cancel';
  cancel.textContent = 'Cancel';
  cancel.setAttribute('aria-label', `Cancel editing description for ${entry.name}`);
  save.addEventListener('click', commit);
  cancel.addEventListener('click', () => renderDescription(entry, body, handlers));
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) {
      ev.preventDefault();
      commit();
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      renderDescription(entry, body, handlers);
    }
  });
  actions.append(save, cancel);
  body.append(input, actions);
  input.focus();
}
