// The element inspector (issue #142): a read-only, right-hand panel describing the currently-selected
// domain element — its stereotype, description, properties, behaviors, and (when reachable) invariants,
// published events, and repository. Pure DOM builder decoupled from the LSP/editor via a `handlers`
// object, so it unit-tests cleanly under happy-dom (mirrors `glossary.ts` / `modelOutline.ts`).
//
// Data comes from two existing LSP sources, joined by `buildInspectorElement`:
//   • `glossaryModel` entry → name, kind, context, description (`doc`), jump-to-source `nameRange`.
//   • `livingDocs` `DiagramNode` → stereotype + member rows (properties = `field`, behaviors =
//     `method`, values = `value`).
// Invariants / published events / repository are NOT on the wire today (they are not `DiagramNode`
// members), so the element fields are optional and the panel renders those compartments only when a
// future minimal emitter change populates them — the layout is forward-compatible.
import type { DiagramNode, GlossaryEntry, Range } from './lsp';

/** The flat, render-ready projection of a selected element (decoupled from the wire DTOs). */
export interface InspectorElement {
  /** The glossary entry id — the key for persisting a description via `setDoc`. */
  id: string;
  name: string;
  qualifiedName: string;
  context: string;
  /** The glossary construct kind, e.g. `aggregate` — the stereotype's fallback. */
  kind: string;
  /** UML stereotype (e.g. `aggregate root`) when the element appears as a class node, else null. */
  stereotype: string | null;
  /** The `///` doc description, or null when undocumented. */
  description: string | null;
  /** Attribute rows (`name: Type`); `computed` marks a derived, get-only property. */
  properties: { text: string; computed: boolean }[];
  /** Method rows, pre-formatted as `name(params): Ret`. */
  behaviors: string[];
  /** Enum value rows (the member names). */
  values: string[];
  /** Invariant expressions — reserved; not yet on the wire. */
  invariants?: string[];
  /** Published domain event names — reserved; not yet on the wire. */
  publishedEvents?: string[];
  /** The bound repository's name — reserved; not yet on the wire. */
  repository?: string | null;
  /** The declaration's name range, for jump-to-source from the header. */
  nameRange: Range;
}

export interface InspectorHandlers {
  /** Jump the editor to the element's declaration. */
  onGoto(range: Range): void;
  /** Commit a new name for the element (a rename across the workspace). Optional — read-only without it. */
  onRename?(element: InspectorElement, newName: string): void;
  /** Persist the element's description as a `///` doc comment. Optional — read-only without it. */
  onSaveDescription?(element: InspectorElement, text: string): void;
}

/**
 * Join a glossary entry (identity + description + source range) with its optional diagram node
 * (stereotype + member rows) into a render-ready {@link InspectorElement}. The diagram node is
 * absent for elements that have no class diagram (e.g. a standalone value object) — those still
 * inspect, just without members/stereotype.
 */
export function buildInspectorElement(entry: GlossaryEntry, node: DiagramNode | undefined): InspectorElement {
  const members = node?.members ?? [];
  return {
    id: entry.id,
    name: entry.name,
    qualifiedName: entry.qualifiedName,
    context: entry.context,
    kind: entry.kind,
    stereotype: node?.stereotype ?? null,
    description: entry.doc,
    properties: members
      .filter((m) => m.kind === 'field' || m.kind === 'computed')
      .map((m) => ({ text: m.text, computed: m.kind === 'computed' })),
    behaviors: members.filter((m) => m.kind === 'method').map((m) => m.text),
    values: members.filter((m) => m.kind === 'value').map((m) => m.text),
    nameRange: entry.nameRange,
  };
}

/** Build the inspector panel for the selected element, or an empty state when nothing is selected. */
export function renderInspector(element: InspectorElement | null, handlers: InspectorHandlers): HTMLElement {
  const root = document.createElement('div');
  root.className = 'koi-inspector';

  if (!element) {
    root.classList.add('koi-inspector-empty');
    const hint = document.createElement('p');
    hint.className = 'koi-inspector-hint muted';
    hint.textContent = 'Select an element in the model outline or a diagram to inspect it.';
    root.appendChild(hint);
    return root;
  }

  root.dataset.qname = element.qualifiedName;
  root.appendChild(renderHeader(element, handlers));
  root.appendChild(renderGeneral(element, handlers));

  appendProperties(root, element.properties);
  appendList(root, 'Behaviors', element.behaviors);
  appendList(root, 'Values', element.values);
  appendList(root, 'Invariants', element.invariants ?? []);
  appendList(root, 'Published Events', element.publishedEvents ?? []);
  if (element.repository) appendList(root, 'Repository', [element.repository]);

  return root;
}

function renderHeader(element: InspectorElement, handlers: InspectorHandlers): HTMLElement {
  const header = document.createElement('div');
  header.className = 'koi-inspector-head';

  const name = document.createElement('button');
  name.type = 'button';
  name.className = 'koi-inspector-name';
  name.textContent = element.name;
  name.title = 'Go to declaration';
  name.setAttribute('aria-label', `Go to declaration: ${element.name}`);
  name.addEventListener('click', () => handlers.onGoto(element.nameRange));

  const stereotype = document.createElement('span');
  stereotype.className = 'koi-inspector-stereotype';
  stereotype.textContent = element.stereotype ?? element.kind;

  header.append(name, stereotype);

  const qualified = document.createElement('div');
  qualified.className = 'koi-inspector-qname muted';
  qualified.textContent = element.qualifiedName;
  header.appendChild(qualified);

  return header;
}

/**
 * The "General" compartment: the element's editable Name (commits a rename), its read-only Type
 * (stereotype), and an editable Description (persisted as a `///` doc comment). Editing is wired only
 * when the matching handler is supplied; without it the controls still render but no-op on commit.
 */
function renderGeneral(element: InspectorElement, handlers: InspectorHandlers): HTMLElement {
  const section = document.createElement('section');
  section.className = 'koi-inspector-section koi-inspector-general';

  const h = document.createElement('h5');
  h.className = 'koi-inspector-section-title';
  h.textContent = 'General';
  section.appendChild(h);

  // Name — commits a rename on Enter / blur when changed; Esc reverts.
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'koi-inspector-input';
  nameInput.value = element.name;
  nameInput.spellcheck = false;
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      nameInput.blur();
    } else if (e.key === 'Escape') {
      nameInput.value = element.name;
      nameInput.blur();
    }
  });
  nameInput.addEventListener('blur', () => {
    const next = nameInput.value.trim();
    if (next && next !== element.name) handlers.onRename?.(element, next);
    else nameInput.value = element.name;
  });
  section.appendChild(field('Name', nameInput));

  // Type — read-only (the stereotype, or the construct kind as a fallback).
  const type = document.createElement('div');
  type.className = 'koi-inspector-field-value';
  type.textContent = element.stereotype ?? element.kind;
  section.appendChild(field('Type', type));

  // Description — persists a `///` doc comment on blur when changed.
  const desc = document.createElement('textarea');
  desc.className = 'koi-inspector-textarea koi-inspector-desc';
  desc.value = element.description ?? '';
  desc.rows = 3;
  desc.placeholder = 'Add a description…';
  desc.addEventListener('blur', () => {
    const next = desc.value.trim();
    if (next !== (element.description ?? '').trim()) handlers.onSaveDescription?.(element, next);
  });
  section.appendChild(field('Description', desc));

  return section;
}

/** A labelled field row. Form controls get a matching id/name + the label's `for`, so they are
 * explicitly associated (and screen-reader / DevTools-clean), not only wrapped. */
function field(label: string, control: HTMLElement): HTMLElement {
  const row = document.createElement('label');
  row.className = 'koi-inspector-field';
  const text = document.createElement('span');
  text.className = 'koi-inspector-field-label';
  text.textContent = label;
  if (control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement) {
    const slug = `koi-insp-${label.toLowerCase().replace(/\s+/g, '-')}`;
    control.id = slug;
    control.name = slug;
    row.htmlFor = slug;
  }
  row.append(text, control);
  return row;
}

/** Append a titled compartment listing `items`; a no-op when `items` is empty. */
function appendList(root: HTMLElement, title: string, items: string[]): void {
  if (!items.length) return;
  const section = document.createElement('section');
  section.className = 'koi-inspector-section';

  const h = document.createElement('h5');
  h.className = 'koi-inspector-section-title';
  h.textContent = title;
  section.appendChild(h);

  const ul = document.createElement('ul');
  ul.className = 'koi-inspector-list';
  for (const item of items) {
    const li = document.createElement('li');
    li.className = 'koi-inspector-item';
    li.textContent = item;
    ul.appendChild(li);
  }
  section.appendChild(ul);
  root.appendChild(section);
}

/** Append the Properties compartment; computed (derived) properties render italic. A no-op when empty. */
function appendProperties(root: HTMLElement, items: { text: string; computed: boolean }[]): void {
  if (!items.length) return;
  const section = document.createElement('section');
  section.className = 'koi-inspector-section';

  const h = document.createElement('h5');
  h.className = 'koi-inspector-section-title';
  h.textContent = 'Properties';
  section.appendChild(h);

  const ul = document.createElement('ul');
  ul.className = 'koi-inspector-list';
  for (const item of items) {
    const li = document.createElement('li');
    li.className = item.computed ? 'koi-inspector-item koi-inspector-item-computed' : 'koi-inspector-item';
    li.textContent = item.text;
    ul.appendChild(li);
  }
  section.appendChild(ul);
  root.appendChild(section);
}
