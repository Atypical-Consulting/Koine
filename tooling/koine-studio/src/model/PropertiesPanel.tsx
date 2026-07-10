import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import type { StoreApi } from 'zustand/vanilla';
import type { AppState } from '@/store/index';
import { useAppStore } from '@/store/hooks';
import type { Range } from '@/lsp/lsp';
import type { ChangeEntry } from '@/host/gitHistory';
import {
  buildInspectorElement,
  formatHistoryDate,
  KOINE_BUILTIN_TYPES,
  type InspectorElement,
  type InspectorHandlers,
} from '@/model/inspector';
import { lookupElement, type ModelIndex } from '@/model/modelIndex';
import { normalizeDddKind } from '@/model/dddKind';
import { useEditableField } from '@/shared/useEditableField';

/**
 * The type names the Properties panel offers as autocomplete for a property's type: the model's own
 * declared types (every glossary entry except bounded contexts) followed by the language built-ins,
 * deduped with declaration order preserved. Empty until the model index has resolved.
 */
function knownTypesFrom(index: ModelIndex | null): string[] {
  const declared = (index?.glossary.entries ?? [])
    .filter((e) => e.kind !== 'context')
    .map((e) => e.name);
  return Array.from(new Set([...declared, ...KOINE_BUILTIN_TYPES]));
}

/** The id of the shared <datalist> the property type inputs autocomplete against (one per panel). */
const TYPE_OPTIONS_ID = 'koi-inspector-type-options';

/** The DDD kinds (after `normalizeDddKind`) the shared `--koi-ddd-*` palette and Explorer icons have
 * an accent for. Anything else (including the still-unrouted service/repository/command/query) falls
 * back to the generic `type` accent. */
const PALETTE = new Set(['aggregate', 'entity', 'enum', 'event', 'value', 'integration-event']);

/**
 * Normalize a glossary construct kind to the key the shared DDD palette (`--koi-ddd-*`) and the
 * Explorer icons use, so the inspector's accent matches them. Unknown kinds fall back to `type`.
 * Folds the backend's `quantity`/`integration event` spellings via the canonical `@/model/dddKind`
 * alias fold (issue #1162) — the same one `src/launcher/buildCatalog.ts`'s `normalizeKind` delegates
 * to, so the two call sites can no longer drift.
 */
function constructKey(kind: string): string {
  const k = normalizeDddKind(kind);
  return PALETTE.has(k) ? k : 'type';
}

// The right-rail Properties inspector as a Preact panel (issue #142, #992). It subscribes to the
// `selection` slice ONLY, so an unrelated slice change (e.g. a bottom-tab switch) never re-renders it
// — the strangler step that kills the cross-panel sync bugs. The joined model index is passed in (the
// controller owns the fetch); when nothing is selected or the index is absent, the panel renders its
// own empty state. #992 retired the pure-DOM `renderInspector` builder and its callback-ref mount in
// favor of this real JSX tree; the "commit" `CustomEvent` the old row inputs synthesized is gone too —
// every editable field now takes an ordinary `onCommit` callback prop.
export function PropertiesPanel(props: {
  store: StoreApi<AppState>;
  index: ModelIndex | null;
  handlers: InspectorHandlers;
}) {
  // Subscribe to exactly the selection slice. `useAppStore` with this selector re-renders the component
  // only when `selection` changes reference — a setBottom/setActiveContext call leaves it alone.
  const selection = useAppStore(props.store, (s) => s.selection);
  const hit = selection && props.index ? lookupElement(props.index, selection.qualifiedName) : null;
  const element: InspectorElement | null = hit
    ? buildInspectorElement(hit.element.entry, hit.element.node, hit.element.modelMembers)
    : null;
  // Memoized: knownTypesFrom scans the whole glossary and only depends on `index`, which changes far
  // less often than `selection` — the slice that drives most of this panel's re-renders (efficiency
  // finding, final #992 review).
  const knownTypes = useMemo(() => knownTypesFrom(props.index), [props.index]);

  // Per-element git change history (#150): fetched asynchronously (the desktop host shells out to git)
  // and rendered once it resolves, so the synchronous panel paint isn't blocked. A null/empty result
  // renders nothing — the section stays hidden on the browser host or outside a git repo. Keyed on the
  // element's qualified name: `alive` is flipped false by the cleanup whenever the selection moves on
  // (or the panel unmounts) BEFORE the fetch settles, so a late resolve for a superseded selection is
  // dropped rather than painted under the new one — the stale-selection guard the old `root.isConnected`
  // / `dataset.qname` DOM check used to provide.
  const [history, setHistory] = useState<ChangeEntry[] | null>(null);
  useEffect(() => {
    setHistory(null); // drop any previous element's entries immediately — never show them under a new one
    if (!element || !props.handlers.loadHistory) return;
    const loadHistory = props.handlers.loadHistory;
    let alive = true;
    // Wrap in Promise.resolve().then so even a synchronous throw inside loadHistory becomes a rejection
    // the .catch swallows, never escaping the effect.
    void Promise.resolve()
      .then(() => loadHistory(element))
      .then((entries) => {
        if (!alive) return;
        setHistory(entries);
      })
      .catch(() => {
        /* history is best-effort — a failure just leaves the section hidden */
      });
    return () => {
      alive = false;
    };
    // `element` is rebuilt fresh on every render (buildInspectorElement is not memoized) and `handlers`
    // is the controller's stable object — refetch only when the SELECTED element's identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on identity, not the fresh-each-render element/handlers references
  }, [element?.qualifiedName]);

  if (!element) {
    return (
      <div class="koi-inspector">
        <div class="koi-rview-empty">
          <h3 class="koi-rview-empty-title">Properties</h3>
          <p class="muted">Select an element in the model outline or a diagram to inspect it.</p>
        </div>
      </div>
    );
  }

  return (
    <div class="koi-inspector" data-qname={element.qualifiedName} data-kind={constructKey(element.kind)}>
      <InspectorHeader element={element} onGoto={props.handlers.onGoto} />
      <GeneralSection element={element} handlers={props.handlers} />
      <PropertyTable
        title="Properties"
        items={element.properties}
        element={element}
        handlers={props.handlers}
        knownTypes={knownTypes}
      />
      <ListSection title="Behaviors" items={element.behaviors} />
      <ListSection title="Values" items={element.values} />
      <ListSection title="Invariants" items={element.invariants ?? []} />
      <ListSection title="Published Events" items={element.publishedEvents ?? []} />
      {element.repository && <ListSection title="Repository" items={[element.repository]} />}
      <ChangeHistory entries={history} />
    </div>
  );
}

/** The header: the editable-by-rename name button (jumps to the declaration), the stereotype badge,
 *  and the qualified name. */
function InspectorHeader(props: { element: InspectorElement; onGoto: (range: Range) => void }) {
  const { element, onGoto } = props;
  return (
    <div class="koi-inspector-head">
      <button
        type="button"
        class="koi-inspector-name"
        title="Go to declaration"
        aria-label={`Go to declaration: ${element.name}`}
        onClick={() => onGoto(element.nameRange)}
      >
        {element.name}
      </button>
      <span class="koi-inspector-stereotype">{element.stereotype ?? element.kind}</span>
      <div class="koi-inspector-qname muted">{element.qualifiedName}</div>
    </div>
  );
}

/**
 * The "General" compartment: the element's editable Name (commits a rename), its read-only Type
 * (stereotype), and an editable Description (persisted as a `///` doc comment). Editing is wired only
 * when the matching handler is supplied; without it the controls still render but no-op on commit.
 * Both fields are `useEditableField` instances (see its contract in `@/shared/useEditableField`) keyed
 * on the element's stable identity (`qualifiedName`) — the hook owns the commit-on-blur/Enter,
 * revert-on-Escape, and identity-change-reset behavior that the #992 reviews caught being re-derived
 * (buggily) per field.
 */
function GeneralSection(props: { element: InspectorElement; handlers: InspectorHandlers }) {
  const { element, handlers } = props;
  const nameField = useEditableField<HTMLInputElement>({
    identity: element.qualifiedName,
    value: element.name,
    onCommit: (next) => handlers.onRename?.(element, next),
  });
  const descriptionField = useEditableField<HTMLTextAreaElement>({
    identity: element.qualifiedName,
    value: (element.description ?? '').trim(),
    onCommit: (next) => handlers.onSaveDescription?.(element, next),
    // Deleting the whole description is a genuine commit (it clears the `///` doc comment) — unlike a
    // name, where blank is invalid and resets instead.
    commitBlank: true,
  });
  return (
    <section class="koi-inspector-section koi-inspector-general">
      <h5 class="koi-inspector-section-title">General</h5>

      <label class="koi-inspector-field" htmlFor="koi-insp-name">
        <span class="koi-inspector-field-label">Name</span>
        <input
          {...nameField}
          id="koi-insp-name"
          name="koi-insp-name"
          type="text"
          class="koi-inspector-input"
          spellcheck={false}
        />
      </label>

      <label class="koi-inspector-field">
        <span class="koi-inspector-field-label">Type</span>
        <div class="koi-inspector-field-value">{element.stereotype ?? element.kind}</div>
      </label>

      <label class="koi-inspector-field" htmlFor="koi-insp-description">
        <span class="koi-inspector-field-label">Description</span>
        {/* The hook's onKeyDown is deliberately NOT wired: this is a multi-line editor, so Enter must
            keep inserting newlines (and Escape was never bound here) — blur is the only commit path,
            exactly as before the #1385 extraction. */}
        <textarea
          key={descriptionField.key}
          ref={descriptionField.ref}
          defaultValue={descriptionField.defaultValue}
          onBlur={descriptionField.onBlur}
          id="koi-insp-description"
          name="koi-insp-description"
          class="koi-inspector-textarea koi-inspector-desc"
          rows={5}
          placeholder="Add a description…"
        />
      </label>
    </section>
  );
}

/** Split a pre-formatted `name: Type` property text into its two columns (a colon-less name keeps an
 *  empty type — mirrors the old `appendPropertyTable` split). */
function splitPropText(text: string): [string, string] {
  const idx = text.indexOf(':');
  const name = idx === -1 ? text.trim() : text.slice(0, idx).trim();
  const type = idx === -1 ? '' : text.slice(idx + 1).trim();
  return [name, type];
}

/**
 * A titled compartment listing `items`; renders nothing when `items` is empty (so an unpopulated
 * compartment — e.g. Repository/Published Events, not yet on the wire — doesn't leave a hollow header).
 */
function ListSection(props: { title: string; items: string[] }) {
  const { title, items } = props;
  if (!items.length) return null;
  return (
    <section class="koi-inspector-section">
      <h5 class="koi-inspector-section-title">{title}</h5>
      <ul class="koi-inspector-list">
        {items.map((item, i) => (
          <li key={i} class="koi-inspector-item">
            {item}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The Properties compartment as a two-column table (property name | type) so the type column aligns to
 * a single left edge regardless of name length. Each item's `text` is pre-formatted as `name: Type`;
 * the first colon splits the two columns. Computed (derived) properties render italic and stay
 * read-only (they are expressions, not editable fields).
 *
 * When any editing handler is supplied, each non-computed row becomes editable — its name and type
 * commit a rename / change-type on blur, a delete button removes the field — and an "add property" row
 * is appended. Without the handlers the rows render read-only (the original behaviour). The edits
 * funnel through the same #91 round-trip the canvas uses, so the `.koi` source and this panel stay in
 * step. Renders nothing when there are no properties AND no add-property affordance to offer.
 */
function PropertyTable(props: {
  title: string;
  items: { text: string; computed: boolean }[];
  element: InspectorElement;
  handlers: InspectorHandlers;
  knownTypes: string[];
}) {
  const { title, items, element, handlers, knownTypes } = props;
  const editable = !!(
    handlers.onRenameProperty ||
    handlers.onChangeType ||
    handlers.onRemoveProperty ||
    handlers.onAddProperty
  );
  if (!items.length && !(editable && handlers.onAddProperty)) return null;

  return (
    <section class="koi-inspector-section">
      <h5 class="koi-inspector-section-title">{title}</h5>
      {/* A shared <datalist> the type inputs autocomplete against (the model's declared types + built-
          ins). Only built when editable (the read-only panel has no inputs to wire it to). */}
      {editable && knownTypes.length > 0 && (
        <datalist id={TYPE_OPTIONS_ID}>
          {knownTypes.map((t) => (
            <option key={t} value={t} />
          ))}
        </datalist>
      )}
      <table class={editable ? 'koi-inspector-table koi-inspector-table-editable' : 'koi-inspector-table'}>
        <tbody>
          {items.map((item) => {
            const [name, type] = splitPropText(item.text);
            return editable && !item.computed ? (
              // Keyed on the OWNING ELEMENT's identity combined with the property's own name — never on
              // the property name alone. Two elements with a same-named property used to reuse the same
              // row (and its uncommitted DOM input value) across a focus-retaining selection change, the
              // same write-leak class the General section's Name/Description fields were fixed for
              // (task-4 review, commit 4631c4d7; see `EditablePropertyRow`'s doc comment).
              <EditablePropertyRow
                key={`${element.qualifiedName}:${name}`}
                element={element}
                handlers={handlers}
                name={name}
                type={type}
              />
            ) : (
              <ReadonlyPropertyRow
                key={name || item.text}
                name={name}
                type={type}
                computed={item.computed}
                aligned={editable}
              />
            );
          })}
        </tbody>
      </table>
      {editable && handlers.onAddProperty && <AddPropertyRow element={element} handlers={handlers} />}
    </section>
  );
}

/**
 * A read-only property row: a `name` header cell + a `type` cell (computed rows render italic). Inside
 * an editable table the name/type are wrapped in input-mimicking static spans (and an empty actions
 * cell is added) so a computed row lines up to the same column edges as the editable input rows.
 */
function ReadonlyPropertyRow(props: { name: string; type: string; computed: boolean; aligned: boolean }) {
  const { name, type, computed, aligned } = props;
  return (
    <tr class={computed ? 'koi-inspector-row koi-inspector-row-computed' : 'koi-inspector-row'}>
      <th scope="row" class="koi-inspector-prop-name">
        {aligned ? <span class="koi-inspector-prop-input koi-inspector-prop-static">{name}</span> : name}
      </th>
      <td class="koi-inspector-prop-type">
        {aligned ? <span class="koi-inspector-prop-input koi-inspector-prop-static">{type}</span> : type}
      </td>
      {aligned && <td class="koi-inspector-prop-actions" />}
    </tr>
  );
}

/**
 * An editable property row: name + type inputs (commit a rename / change-type) and a delete button.
 * Both nested `EditableRow`s are keyed on a composite of the OWNING ELEMENT's stable identity
 * (`element.qualifiedName`) and the property's own identity (`name`) — never on the field's own value
 * alone, and never on `name` alone either (a property name isn't guaranteed unique across elements).
 * Keying by value only (the pre-fix behaviour) let a focus-retaining selection change to a DIFFERENT
 * element that happens to have a same-named property skip the remount, leaving the previous element's
 * uncommitted text in the DOM — and a subsequent blur, now closed over the NEW element, would write
 * that stale text to the wrong element (final #992 review, Finding 1 — the same bug class the General
 * section's Name/Description fields were fixed for; task-4 review, commit 4631c4d7). The type field's
 * key additionally includes `type` itself, preserving `EditableRow`'s original by-value remount (a
 * genuine external type change for the SAME property still refreshes the field), while the name field's
 * key needs no separate value component since a rename already changes `name`, which is part of the key.
 */
function EditablePropertyRow(props: {
  element: InspectorElement;
  handlers: InspectorHandlers;
  name: string;
  type: string;
}) {
  const { element, handlers, name, type } = props;
  const identity = `${element.qualifiedName}:${name}`;
  return (
    <tr class="koi-inspector-row koi-inspector-row-editable">
      <th scope="row" class="koi-inspector-prop-name">
        <EditableRow
          key={identity}
          value={name}
          ariaLabel={`Name of property ${name}`}
          onCommit={(next) => handlers.onRenameProperty?.(element, name, next)}
        />
      </th>
      <td class="koi-inspector-prop-type">
        <EditableRow
          key={`${identity}:${type}`}
          value={type}
          ariaLabel={`Type of property ${name}`}
          list={TYPE_OPTIONS_ID}
          onCommit={(next) => handlers.onChangeType?.(element, name, next)}
        />
      </td>
      <td class="koi-inspector-prop-actions">
        {handlers.onRemoveProperty && (
          <button
            type="button"
            class="koi-inspector-prop-delete"
            title={`Remove ${name}`}
            aria-label={`Remove property ${name}`}
            onClick={() => handlers.onRemoveProperty?.(element, name)}
          >
            ×
          </button>
        )}
      </td>
    </tr>
  );
}

/**
 * A small, uncontrolled text input: Enter blurs, Escape reverts to `value` and blurs, and a changed,
 * non-blank value commits (trimmed) on blur via `onCommit` — an unchanged/blank value is silently
 * reset instead. Replaces the old `propInput` DOM builder and the synthetic `commit` `CustomEvent` it
 * dispatched (#992) — the caller now gets an ordinary callback. Keyed by its caller on `value` (see
 * `EditablePropertyRow`) so a genuine prop change (not just local typing) remounts the field with the
 * fresh `defaultValue`.
 */
function EditableRow(props: { value: string; ariaLabel: string; onCommit: (next: string) => void; list?: string }) {
  const { value, ariaLabel, onCommit, list } = props;
  return (
    <input
      type="text"
      class="koi-inspector-prop-input"
      spellcheck={false}
      aria-label={ariaLabel}
      list={list}
      defaultValue={value}
      onKeyDown={(e) => {
        const input = e.currentTarget as HTMLInputElement;
        if (e.key === 'Enter') {
          e.preventDefault();
          input.blur();
        } else if (e.key === 'Escape') {
          input.value = value;
          input.blur();
        }
      }}
      onBlur={(e) => {
        const input = e.currentTarget as HTMLInputElement;
        const next = input.value.trim();
        if (next && next !== value) onCommit(next);
        else input.value = value;
      }}
    />
  );
}

/**
 * The "add a property" row: a name + type field on one line, with the Add button BELOW them (it
 * commits when both fields are filled). The two-row layout (`koi-inspector-add-prop` column, fields in
 * their own `koi-inspector-add-fields` line) keeps the button from crowding the inputs. The two fields
 * are plain (uncommitted-per-field) inputs — Enter blurs, Escape reverts to blank — since the ADD
 * itself is triggered by the button reading both current values, not by either field's own blur.
 */
function AddPropertyRow(props: { element: InspectorElement; handlers: InspectorHandlers }) {
  const { element, handlers } = props;
  const nameRef = useRef<HTMLInputElement>(null);
  const typeRef = useRef<HTMLInputElement>(null);

  function fieldKeyDown(e: JSX.TargetedKeyboardEvent<HTMLInputElement>): void {
    const input = e.currentTarget;
    if (e.key === 'Enter') {
      e.preventDefault();
      input.blur();
    } else if (e.key === 'Escape') {
      input.value = '';
      input.blur();
    }
  }

  function onAdd(): void {
    const name = nameRef.current?.value.trim() ?? '';
    const type = typeRef.current?.value.trim() ?? '';
    if (!name || !type) return;
    handlers.onAddProperty?.(element, name, type);
    if (nameRef.current) nameRef.current.value = '';
    if (typeRef.current) typeRef.current.value = '';
    nameRef.current?.focus(); // keep the keyboard flow going for adding several in a row
  }

  return (
    <div class="koi-inspector-add-prop">
      <div class="koi-inspector-add-fields">
        <input
          ref={nameRef}
          type="text"
          class="koi-inspector-prop-input koi-inspector-add-name"
          spellcheck={false}
          aria-label="New property name"
          placeholder="name"
          onKeyDown={fieldKeyDown}
        />
        <input
          ref={typeRef}
          type="text"
          class="koi-inspector-prop-input koi-inspector-add-type"
          spellcheck={false}
          aria-label="New property type"
          placeholder="Type"
          list={TYPE_OPTIONS_ID}
          onKeyDown={fieldKeyDown}
        />
      </div>
      <button type="button" class="koi-inspector-add-btn" onClick={onAdd}>
        + Add property
      </button>
    </div>
  );
}

/**
 * The "Change history" compartment (issue #150): the git commits that touched the selected element's
 * source span, newest first, each rendered as `author · date` over the commit message. Renders nothing
 * when history is unavailable (`entries` is `null`, e.g. the browser host or a non-git workspace) or
 * empty. The commit SHA rides on each row's `data-sha` so a future enhancement can open the commit/diff
 * without re-deriving it.
 */
function ChangeHistory(props: { entries: ChangeEntry[] | null }) {
  const { entries } = props;
  if (!entries || entries.length === 0) return null;
  return (
    <section class="koi-inspector-section koi-inspector-history">
      <h5 class="koi-inspector-section-title">Change history</h5>
      <ul class="koi-inspector-list">
        {entries.map((entry) => (
          <li key={entry.sha} class="koi-inspector-item koi-inspector-history-item" data-sha={entry.sha}>
            <div class="koi-inspector-history-meta muted">
              {entry.author} · {formatHistoryDate(entry.date)}
            </div>
            <div class="koi-inspector-history-message">{entry.message}</div>
          </li>
        ))}
      </ul>
    </section>
  );
}
