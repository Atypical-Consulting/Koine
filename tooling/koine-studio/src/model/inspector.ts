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
import type { DiagramNode, GlossaryEntry, ModelMember, Range, SourceSpan } from '@/lsp/lsp';
import type { WorkspaceEdit } from '@/lsp/protocol';
import type { ChangeEntry } from '@/host/gitHistory';
import { railHint, renderRailEmpty } from '@/model/railEmpty';

/**
 * The language's built-in scalar/collection types — the always-available options for a property's
 * type autocomplete, merged with the model's own declared types (passed as `knownTypes`). Mirrors the
 * editor's `TYPES` list (editor.ts) so the panel and the code editor offer the same vocabulary.
 */
export const KOINE_BUILTIN_TYPES = ['String', 'Int', 'Decimal', 'Bool', 'Instant', 'List', 'Set', 'Map', 'Range'];

/** The id of the shared <datalist> the property type inputs autocomplete against (one per panel). */
const TYPE_OPTIONS_ID = 'koi-inspector-type-options';

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
  /**
   * The declaration's full source span — its file uri + line range — when the element has a diagram
   * node (issue #150). Carries the *correct* file even in a multi-file workspace, so the change-history
   * lookup scopes git to the element's own declaration rather than whatever file the editor shows.
   * Absent for elements with no diagram node (e.g. an undrawn value object); the lookup then falls back
   * to the active file + {@link nameRange}.
   */
  sourceSpan?: SourceSpan | null;
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
  /**
   * Fetch the git change history for the element's source span (issue #150) — the commits that touched
   * its declaration, newest first. Resolves `null` when history is unavailable (browser host, not a git
   * repo), so the "Change history" section stays hidden. Optional — absent ⇒ no history section.
   */
  loadHistory?(element: InspectorElement): Promise<ChangeEntry[] | null>;
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
    // Business rules now ride on the diagram node (the invariants-on-the-wire change): each is the
    // invariant's message or its described condition. Undefined when the node carries none.
    invariants: node?.invariants && node.invariants.length > 0 ? node.invariants : undefined,
    nameRange: entry.nameRange,
    // The diagram node carries the declaration's file + line range; null for undrawn elements (the
    // change-history lookup then falls back to the active file + name range).
    sourceSpan: node?.sourceSpan ?? null,
  };
}

/**
 * The status-line message shown after renaming `element` to `newName`.
 *
 * For an aggregate root whose identity follows the `<Root>Id` convention, the rename refactor also
 * co-renames that identity type (`OrderId` → `PurchaseOrderId`) in the same edit (#550). When it could
 * NOT — an ambiguous link or a name collision left the id behind — this flags that the id type was left
 * unchanged, so the user isn't silently left with a mismatched `OrderId` on a `PurchaseOrder`. For every
 * other element (or when the co-rename did happen) it's just the plain "Renamed X → Y".
 */
export function renameStatusMessage(
  element: Pick<InspectorElement, 'name' | 'properties' | 'stereotype'>,
  newName: string,
  edit: WorkspaceEdit,
): string {
  const base = `Renamed ${element.name} → ${newName}`;
  // Only aggregate roots carry a convention-linked identity type worth co-renaming.
  if (element.stereotype !== 'aggregate root') {
    return base;
  }

  const oldId = `${element.name}Id`;
  const hasConventionId = element.properties.some((p) => p.text === `id: ${oldId}`);
  if (!hasConventionId) {
    return base;
  }

  const newId = `${newName}Id`;
  const coRenamed = Object.values(edit.changes).some((edits) => edits.some((e) => e.newText === newId));
  return coRenamed ? base : `${base}; id type ${oldId} left unchanged`;
}

/**
 * Build the inspector panel for the selected element, or an empty state when nothing is selected.
 * `knownTypes` seeds the property type autocomplete (the model's declared types + the language's
 * built-ins); empty when no model index is available yet (the inputs still accept free text).
 */
export function renderInspector(
  element: InspectorElement | null,
  handlers: InspectorHandlers,
  knownTypes: string[] = [],
): HTMLElement {
  const root = document.createElement('div');
  root.className = 'koi-inspector';

  if (!element) {
    // The shared rail empty state (same builder the Rules/Notes tabs use), nested inside the padded
    // `.koi-inspector` root so it picks up the same panel margin as the other two tabs.
    root.appendChild(
      renderRailEmpty('Properties', railHint('Select an element in the model outline or a diagram to inspect it.')),
    );
    return root;
  }

  root.dataset.qname = element.qualifiedName;
  // Tag the panel with its DDD construct so the header echoes the diagram/Explorer colour language
  // (the shared --koi-ddd-* palette): the same element reads the same across canvas, tree, and panel.
  root.dataset.kind = constructKey(element.kind);
  root.appendChild(renderHeader(element, handlers));
  root.appendChild(renderGeneral(element, handlers));

  appendPropertyTable(root, 'Properties', element.properties, element, handlers, knownTypes);
  appendList(root, 'Behaviors', element.behaviors);
  appendList(root, 'Values', element.values);
  appendList(root, 'Invariants', element.invariants ?? []);
  appendList(root, 'Published Events', element.publishedEvents ?? []);
  if (element.repository) appendList(root, 'Repository', [element.repository]);

  return root;
}

/**
 * The right-rail "Rules" tab: the selected element's business rules (its invariants), or an empty
 * state. Read-only — invariants are authored in the `.koi` source and flagged live in the Problems
 * panel; this view just surfaces them per element. Reuses the same flat {@link InspectorElement}
 * projection as the Properties inspector so it tracks selection identically.
 */
export function renderRules(element: InspectorElement | null): HTMLElement {
  if (!element) {
    return renderRailEmpty(
      'Business rules',
      railHint(
        'Select an element in the model outline or a diagram to see its invariants. Rules are authored in the .koi source and flagged live in the Problems panel.',
      ),
    );
  }

  const rules = element.invariants ?? [];
  const title = `${element.name} — business rules`;
  if (rules.length === 0) {
    return renderRailEmpty(title, railHint('No invariants declared on this element.'));
  }

  const ul = document.createElement('ul');
  ul.className = 'koi-inspector-list';
  for (const rule of rules) {
    const li = document.createElement('li');
    li.className = 'koi-inspector-item';
    li.textContent = rule;
    ul.appendChild(li);
  }
  return renderRailEmpty(title, ul);
}

/**
 * The inspector's "Change history" compartment (issue #150): the git commits that touched the selected
 * element's source span, newest first, each rendered as `author · date` over the commit message. Returns
 * `null` — so the caller appends nothing and the section stays hidden — when history is unavailable
 * (`entries` is `null`, e.g. the browser host or a non-git workspace) or empty. The commit SHA rides on
 * each row's `data-sha` so a future enhancement can open the commit/diff without re-deriving it.
 */
export function renderChangeHistory(entries: ChangeEntry[] | null): HTMLElement | null {
  if (!entries || entries.length === 0) return null;

  const section = document.createElement('section');
  section.className = 'koi-inspector-section koi-inspector-history';

  const h = document.createElement('h5');
  h.className = 'koi-inspector-section-title';
  h.textContent = 'Change history';
  section.appendChild(h);

  const ul = document.createElement('ul');
  ul.className = 'koi-inspector-list';
  for (const entry of entries) {
    const li = document.createElement('li');
    li.className = 'koi-inspector-item koi-inspector-history-item';
    li.dataset.sha = entry.sha;

    const meta = document.createElement('div');
    meta.className = 'koi-inspector-history-meta muted';
    meta.textContent = `${entry.author} · ${formatHistoryDate(entry.date)}`;

    const message = document.createElement('div');
    message.className = 'koi-inspector-history-message';
    message.textContent = entry.message;

    li.append(meta, message);
    ul.appendChild(li);
  }
  section.appendChild(ul);
  return section;
}

/**
 * Format a commit's author date for a change-history row: the `YYYY-MM-DD` calendar day of an ISO-8601
 * string (timezone-stable and locale-free, so snapshots/tests stay deterministic), or the raw value
 * when it isn't ISO-shaped.
 */
function formatHistoryDate(date: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(date);
  return m ? m[1] : date;
}

/**
 * Normalize a glossary construct kind to the key the shared DDD palette (`--koi-ddd-*`) and the
 * Explorer icons use, so the inspector's accent matches them. Unknown kinds fall back to `type`.
 */
function constructKey(kind: string): string {
  switch (kind) {
    case 'aggregate':
    case 'entity':
    case 'enum':
    case 'event':
      return kind;
    case 'value':
    case 'quantity':
      return 'value';
    case 'integration event':
      return 'integration-event';
    default:
      return 'type';
  }
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
  desc.rows = 5;
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
  knownTypes: string[] = [],
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

  // A shared <datalist> the type inputs autocomplete against (the model's declared types + built-ins).
  // Only built when editable (the read-only panel has no inputs to wire it to).
  if (editable && knownTypes.length) section.appendChild(typeOptionsList(knownTypes));

  const table = document.createElement('table');
  // An editable table mixes input rows with read-only computed rows; the `-editable` modifier aligns
  // both kinds to one set of column edges (see _model.scss) so computed properties line up.
  table.className = editable ? 'koi-inspector-table koi-inspector-table-editable' : 'koi-inspector-table';
  const tbody = document.createElement('tbody');
  for (const item of items) {
    const idx = item.text.indexOf(':');
    const name = idx === -1 ? item.text.trim() : item.text.slice(0, idx).trim();
    const type = idx === -1 ? '' : item.text.slice(idx + 1).trim();
    tbody.appendChild(
      editable && !item.computed
        ? editablePropertyRow(element, handlers, name, type)
        : readonlyPropertyRow(name, type, item.computed, editable),
    );
  }
  table.appendChild(tbody);
  section.appendChild(table);

  if (editable && handlers.onAddProperty) section.appendChild(addPropertyRow(element, handlers));
  root.appendChild(section);
}

/** The shared autocomplete option list for property type inputs (deduped, declaration order kept). */
function typeOptionsList(knownTypes: string[]): HTMLDataListElement {
  const list = document.createElement('datalist');
  list.id = TYPE_OPTIONS_ID;
  for (const t of knownTypes) {
    const opt = document.createElement('option');
    opt.value = t;
    list.appendChild(opt);
  }
  return list;
}

/**
 * A read-only property row: a `name` header cell + a `type` cell (computed rows render italic). Inside
 * an editable table the name/type are wrapped in input-mimicking static spans (and an empty actions
 * cell is added) so a computed row lines up to the same column edges as the editable input rows.
 */
function readonlyPropertyRow(name: string, type: string, computed: boolean, aligned = false): HTMLTableRowElement {
  const row = document.createElement('tr');
  row.className = computed ? 'koi-inspector-row koi-inspector-row-computed' : 'koi-inspector-row';
  // The property name labels its row, so it is a row-scoped header (accessible + DevTools-clean).
  const nameCell = document.createElement('th');
  nameCell.scope = 'row';
  nameCell.className = 'koi-inspector-prop-name';
  const typeCell = document.createElement('td');
  typeCell.className = 'koi-inspector-prop-type';
  if (aligned) {
    nameCell.appendChild(staticPropValue(name));
    typeCell.appendChild(staticPropValue(type));
    const actions = document.createElement('td');
    actions.className = 'koi-inspector-prop-actions';
    row.append(nameCell, typeCell, actions);
  } else {
    nameCell.textContent = name;
    typeCell.textContent = type;
    row.append(nameCell, typeCell);
  }
  return row;
}

/** A read-only value styled like the editable inputs so it shares their box model (exact alignment). */
function staticPropValue(text: string): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = 'koi-inspector-prop-input koi-inspector-prop-static';
  span.textContent = text;
  return span;
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
  typeInput.setAttribute('list', TYPE_OPTIONS_ID); // autocomplete against the known-types datalist
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

/**
 * The "add a property" row: a name + type field on one line, with the Add button BELOW them (it
 * commits when both fields are filled). The two-row layout (`koi-inspector-add-prop` column, fields in
 * their own `koi-inspector-add-fields` line) keeps the button from crowding the inputs.
 */
function addPropertyRow(element: InspectorElement, handlers: InspectorHandlers): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'koi-inspector-add-prop';

  const fields = document.createElement('div');
  fields.className = 'koi-inspector-add-fields';

  const nameInput = propInput('', 'New property name');
  nameInput.classList.add('koi-inspector-add-name');
  nameInput.placeholder = 'name';
  const typeInput = propInput('', 'New property type');
  typeInput.classList.add('koi-inspector-add-type');
  typeInput.placeholder = 'Type';
  typeInput.setAttribute('list', TYPE_OPTIONS_ID); // autocomplete against the known-types datalist
  fields.append(nameInput, typeInput);

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
    nameInput.focus(); // keep the keyboard flow going for adding several in a row
  });

  wrap.append(fields, add);
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
