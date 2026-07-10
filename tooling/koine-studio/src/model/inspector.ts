// The element inspector's pure, target-agnostic model layer (issue #142, #992). The presentation used
// to live here too (a pure-DOM builder, `renderInspector`), decoupled from the LSP/editor via a
// `handlers` object; #992 retired that builder in favor of real JSX (`@/model/PropertiesPanel`), so
// this module now holds only the wire-decoupled join + business logic the panel (and `ide.tsx`'s
// rename write-path) consume, with no DOM concept at all.
//
// Data comes from two existing LSP sources, joined by `buildInspectorElement`:
//   • `glossaryModel` entry → name, kind, context, description (`doc`), jump-to-source `nameRange`.
//   • `livingDocs` `DiagramNode` → stereotype + member rows (properties = `field`, behaviors =
//     `method`, values = `value`).
// Invariants ARE on the wire (`DiagramNode.invariants`, joined in by `buildInspectorElement` below);
// published events and repository are NOT (no `DiagramNode` field carries them yet). All three element
// fields stay optional regardless, so the panel renders those compartments only when populated — the
// layout is forward-compatible with a future minimal emitter change for the other two.
import type { DiagramNode, GlossaryEntry, ModelMember, Range, SourceSpan } from '@/lsp/lsp';
import type { WorkspaceEdit } from '@/lsp/protocol';
import type { ChangeEntry } from '@/host/gitHistory';

/**
 * The language's built-in scalar/collection types — the always-available options for a property's
 * type autocomplete, merged with the model's own declared types (passed as `knownTypes`). Mirrors the
 * editor's `TYPES` list (editor.ts) so the panel and the code editor offer the same vocabulary.
 */
export const KOINE_BUILTIN_TYPES = ['String', 'Int', 'Decimal', 'Bool', 'Instant', 'List', 'Set', 'Map', 'Range'];

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
  /** Invariant expressions, joined from the diagram node's `invariants` when present; undefined when the node carries none. */
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
 * The status-pill warning shown after renaming `element` to `newName`, or null when there's nothing to flag.
 *
 * For an aggregate root whose identity follows the `<Root>Id` convention, the rename refactor also
 * co-renames that identity type (`OrderId` → `PurchaseOrderId`) in the same edit (#550). When it could
 * NOT — an ambiguous link or a name collision left the id behind — this flags that the id type was left
 * unchanged, so the user isn't silently left with a mismatched `OrderId` on a `PurchaseOrder`. Every other
 * case (a plain rename, or a root whose co-rename did happen) has nothing worth surfacing.
 */
export function renameStatusMessage(
  element: Pick<InspectorElement, 'name' | 'properties' | 'stereotype'>,
  newName: string,
  edit: WorkspaceEdit,
): string | null {
  // Only aggregate roots carry a convention-linked identity type worth co-renaming.
  if (element.stereotype !== 'aggregate root') {
    return null;
  }

  const oldId = `${element.name}Id`;
  const hasConventionId = element.properties.some((p) => p.text === `id: ${oldId}`);
  if (!hasConventionId) {
    return null;
  }

  const newId = `${newName}Id`;
  const coRenamed = Object.values(edit.changes).some((edits) => edits.some((e) => e.newText === newId));
  return coRenamed ? null : `Renamed ${element.name} → ${newName}; id type ${oldId} left unchanged`;
}

/**
 * Format a commit's author date for a change-history row: the `YYYY-MM-DD` calendar day of an ISO-8601
 * string (timezone-stable and locale-free, so snapshots/tests stay deterministic), or the raw value
 * when it isn't ISO-shaped. Used by `PropertiesPanel`'s `ChangeHistory` compartment.
 */
export function formatHistoryDate(date: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(date);
  return m ? m[1] : date;
}
