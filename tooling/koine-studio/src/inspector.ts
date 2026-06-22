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
import type { DiagramNode, GlossaryEntry, ModelMember, Range } from './lsp';

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
  // --- property editing (authoring) — each maps to a structured edit; absent ⇒ read-only Properties ---
  /** Add a field to the element. */
  onAddProperty?(element: InspectorElement, name: string, type: string): void;
  /** Remove the element's field named `propName`. */
  onRemoveProperty?(element: InspectorElement, propName: string): void;
  /** Rename the element's field `oldName` → `newName`. */
  onRenameProperty?(element: InspectorElement, oldName: string, newName: string): void;
  /** Change the type of the element's field `propName` to `newType`. */
  onChangeType?(element: InspectorElement, propName: string, newType: string): void;
}

/**
 * Join a glossary entry (identity + description + source range) with its optional diagram node
 * (stereotype + member rows) into a render-ready {@link InspectorElement}. The diagram node is
 * absent for elements that have no class diagram (e.g. a standalone value object) — those still
 * inspect, and their properties come from the optional structured-model members ({@link ModelMember},
 * the #91 round-trip seam), which carry every element's fields regardless of diagramming. The diagram
 * node wins when present (it also distinguishes computed members and carries behaviors); the model is
 * the fallback so a value object whose fields aren't drawn anywhere still lists them.
 */
export function buildInspectorElement(
  entry: GlossaryEntry,
  node: DiagramNode | undefined,
  modelMembers?: ModelMember[],
): InspectorElement {
  const members = node?.members ?? [];
  const nodeProperties = members
    .filter((m) => m.kind === 'field' || m.kind === 'computed')
    .map((m) => ({ text: m.text, computed: m.kind === 'computed' }));
  // Fallback: when the element has no class-node members (a value object not drawn as a class box),
  // derive its properties from the structured model's `field` members — `name: type`, with an
  // initializer (`value`) marking a derived/computed property (matching the diagram's italic rows).
  const properties = nodeProperties.length
    ? nodeProperties
    : (modelMembers ?? [])
        .filter((m) => m.kind === 'field')
        .map((m) => ({ text: m.type ? `${m.name}: ${m.type}` : m.name, computed: m.value != null }));
  return {
    id: entry.id,
    name: entry.name,
    qualifiedName: entry.qualifiedName,
    context: entry.context,
    kind: entry.kind,
    stereotype: node?.stereotype ?? null,
    description: entry.doc,
    properties,
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

  appendPropertyTable(root, 'Properties', element.properties, element, handlers);
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

/**
 * Append the Properties compartment as a two-column table (property name | type) so the type column
 * aligns to a single left edge regardless of name length. Each item's `text` is pre-formatted as
 * `name: Type`; the first colon splits the two columns. Computed (derived) properties render italic and
 * stay read-only (they are expressions, not editable fields).
 *
 * When the editing handlers are supplied, each non-computed row becomes editable — its name and type
 * commit a rename / change-type on blur, a delete button removes the field — and an "add property" row is
 * appended. Without the handlers the rows render read-only (the original behaviour). The edits funnel
 * through the same #91 round-trip the canvas uses, so the `.koi` source and this panel stay in step.
 */
function appendPropertyTable(
  root: HTMLElement,
  title: string,
  items: { text: string; computed: boolean }[],
  element: InspectorElement,
  handlers: InspectorHandlers,
): void {
  const editable = !!(
    handlers.onRenameProperty ||
    handlers.onChangeType ||
    handlers.onRemoveProperty ||
    handlers.onAddProperty
  );
  if (!items.length && !(editable && handlers.onAddProperty)) return;

  const section = document.createElement('section');
  section.className = 'koi-inspector-section';

  const h = document.createElement('h5');
  h.className = 'koi-inspector-section-title';
  h.textContent = title;
  section.appendChild(h);

  const table = document.createElement('table');
  table.className = 'koi-inspector-table';
  const tbody = document.createElement('tbody');
  for (const item of items) {
    const idx = item.text.indexOf(':');
    const name = idx === -1 ? item.text.trim() : item.text.slice(0, idx).trim();
    const type = idx === -1 ? '' : item.text.slice(idx + 1).trim();
    tbody.appendChild(
      editable && !item.computed
        ? editablePropertyRow(element, handlers, name, type)
        : readonlyPropertyRow(name, type, item.computed),
    );
  }
  table.appendChild(tbody);
  section.appendChild(table);

  if (editable && handlers.onAddProperty) section.appendChild(addPropertyRow(element, handlers));
  root.appendChild(section);
}

/** A read-only property row: a `name` header cell + a `type` cell (computed rows render italic). */
function readonlyPropertyRow(name: string, type: string, computed: boolean): HTMLTableRowElement {
  const row = document.createElement('tr');
  row.className = computed ? 'koi-inspector-row koi-inspector-row-computed' : 'koi-inspector-row';
  // The property name labels its row, so it is a row-scoped header (accessible + DevTools-clean).
  const nameCell = document.createElement('th');
  nameCell.scope = 'row';
  nameCell.className = 'koi-inspector-prop-name';
  nameCell.textContent = name;
  const typeCell = document.createElement('td');
  typeCell.className = 'koi-inspector-prop-type';
  typeCell.textContent = type;
  row.append(nameCell, typeCell);
  return row;
}

/** An editable property row: name + type inputs (commit a rename / change-type) and a delete button. */
function editablePropertyRow(
  element: InspectorElement,
  handlers: InspectorHandlers,
  name: string,
  type: string,
): HTMLTableRowElement {
  const row = document.createElement('tr');
  row.className = 'koi-inspector-row koi-inspector-row-editable';

  const nameCell = document.createElement('th');
  nameCell.scope = 'row';
  nameCell.className = 'koi-inspector-prop-name';
  const nameInput = propInput(name, `Name of property ${name}`);
  nameInput.addEventListener('commit', () => {
    const next = nameInput.value.trim();
    if (next && next !== name) handlers.onRenameProperty?.(element, name, next);
    else nameInput.value = name;
  });
  nameCell.appendChild(nameInput);

  const typeCell = document.createElement('td');
  typeCell.className = 'koi-inspector-prop-type';
  const typeInput = propInput(type, `Type of property ${name}`);
  typeInput.addEventListener('commit', () => {
    const next = typeInput.value.trim();
    if (next && next !== type) handlers.onChangeType?.(element, name, next);
    else typeInput.value = type;
  });
  typeCell.appendChild(typeInput);

  const actions = document.createElement('td');
  actions.className = 'koi-inspector-prop-actions';
  if (handlers.onRemoveProperty) {
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'koi-inspector-prop-delete';
    del.textContent = '×';
    del.title = `Remove ${name}`;
    del.setAttribute('aria-label', `Remove property ${name}`);
    del.addEventListener('click', () => handlers.onRemoveProperty?.(element, name));
    actions.appendChild(del);
  }

  row.append(nameCell, typeCell, actions);
  return row;
}

/** The "add a property" row: a name + type field and an Add button that commits when both are filled. */
function addPropertyRow(element: InspectorElement, handlers: InspectorHandlers): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'koi-inspector-add-prop';

  const nameInput = propInput('', 'New property name');
  nameInput.classList.add('koi-inspector-add-name');
  nameInput.placeholder = 'name';
  const typeInput = propInput('', 'New property type');
  typeInput.classList.add('koi-inspector-add-type');
  typeInput.placeholder = 'Type';

  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'koi-inspector-add-btn';
  add.textContent = '+ Add property';
  add.addEventListener('click', () => {
    const name = nameInput.value.trim();
    const type = typeInput.value.trim();
    if (!name || !type) return;
    handlers.onAddProperty?.(element, name, type);
    nameInput.value = '';
    typeInput.value = '';
  });

  wrap.append(nameInput, typeInput, add);
  return wrap;
}

/** A small text input that fires a synthetic `commit` event on Enter/blur and reverts on Escape. */
function propInput(value: string, ariaLabel: string): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'koi-inspector-prop-input';
  input.value = value;
  input.spellcheck = false;
  input.setAttribute('aria-label', ariaLabel);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      input.blur();
    } else if (e.key === 'Escape') {
      input.value = value;
      input.blur();
    }
  });
  input.addEventListener('blur', () => input.dispatchEvent(new CustomEvent('commit')));
  return input;
}
