// The DDD-semantic model-outline explorer (issue #142): a navigator that re-frames the model the way
// a Domain Developer / Architect thinks — grouped by DDD construct *per bounded context* — rather
// than as a flat file/symbol tree. Pure DOM builders decoupled from the LSP/editor via a `handlers`
// object, so they unit-test cleanly under happy-dom (mirrors `glossary.ts`).
//
// Source of truth: `koine/glossaryModel` (`GlossaryModel`), the workspace-merged inventory of every
// declared type carrying its construct `kind`, owning `context`, a `nameRange` for jump-to-source,
// and its `doc`. The richer-but-narrower `DiagramGraph` (members/stereotype) drives the *inspector*;
// it is NOT the outline backbone because its aggregate diagrams only enumerate nested types, so a
// top-level value object would be missed — the glossary lists them all.
import type { GlossaryEntry, GlossaryModel } from '@/lsp/lsp';
import { groupByContext } from '@/model/glossary';

/**
 * The DDD construct buckets, in the display order the navigator renders them. Each maps the glossary
 * `kind` strings (see `GlossaryModelBuilder.KindOf`) that fold into it — e.g. both `value` and the
 * `quantity` special-case are Value Objects. `context` entries are headers, never buckets.
 */
export const CONSTRUCTS: ReadonlyArray<{ label: string; kinds: ReadonlyArray<string> }> = [
  { label: 'Aggregates', kinds: ['aggregate'] },
  { label: 'Entities', kinds: ['entity'] },
  { label: 'Value Objects', kinds: ['value', 'quantity'] },
  { label: 'Enumerations', kinds: ['enum'] },
  { label: 'Domain Events', kinds: ['event'] },
  { label: 'Integration Events', kinds: ['integration event'] },
  { label: 'Types', kinds: ['type'] },
  // Behavioural & lifecycle constructs (#453). The glossary (`KindOf`) does not surface these kinds as
  // outline rows yet, and the structured model graph only emits `states` today (Phase 2 brings the rest),
  // so these buckets stay empty — and are dropped from the outline — for now. They live HERE, in the one
  // construct table, so the SAME grammar resolves a glyph (slug + colour) for a `states`/`command`/… node
  // the instant it starts appearing in the tactical tree — no second, divergent map.
  { label: 'State Machines', kinds: ['states'] },
  { label: 'Commands', kinds: ['command'] },
  { label: 'Queries', kinds: ['query'] },
  { label: 'Read Models', kinds: ['read-model'] },
  { label: 'Policies', kinds: ['policy'] },
  { label: 'Domain Services', kinds: ['service'] },
  { label: 'Repositories', kinds: ['repository'] },
  { label: 'Factories', kinds: ['factory'] },
  { label: 'Specifications', kinds: ['spec'] },
];

const LABEL_OF_KIND = new Map<string, string>(
  CONSTRUCTS.flatMap((c) => c.kinds.map((k) => [k, c.label] as const)),
);

export interface ConstructGroup {
  label: string;
  entries: GlossaryEntry[];
}

export interface ContextGroup {
  context: string;
  /** The context's own glossary entry (for the header's jump-to-source), if present. */
  contextEntry: GlossaryEntry | null;
  constructs: ConstructGroup[];
}

export interface ConstructCount {
  label: string;
  count: number;
}

export interface ModelOutlineHandlers {
  /** Select an element (drives the inspector + cross-highlight). */
  onSelect(entry: GlossaryEntry): void;
  /** Jump the editor to a 1-based line/column (same contract `loadOutline` uses). */
  goto(line: number, col: number): void;
  /** Open the Context Map view (the top-level "Context Map" entry). */
  onOpenContextMap?(): void;
  /** Open the Glossary view (the top-level "Ubiquitous Language" entry). */
  onOpenGlossary?(): void;
}

/**
 * Group the glossary entries by bounded context (first-seen order), then by DDD construct (in
 * {@link CONSTRUCTS} display order). The context's own entry becomes the group header, not a leaf;
 * empty construct buckets are dropped. Within a bucket, entries keep declaration order.
 */
export function groupByConstruct(model: GlossaryModel): ContextGroup[] {
  const order = new Map(CONSTRUCTS.map((c, i) => [c.label, i] as const));
  // Reuse the glossary's proven context grouping (first-seen context + entry order) so the Model and
  // Glossary tabs always present the same contexts in the same order; then bucket each by construct.
  return groupByContext(model.entries).map((g) => {
    let contextEntry: GlossaryEntry | null = null;
    const constructs: ConstructGroup[] = [];
    for (const e of g.entries) {
      if (e.kind === 'context') {
        contextEntry ??= e;
        continue;
      }
      const label = LABEL_OF_KIND.get(e.kind) ?? 'Types';
      let bucket = constructs.find((c) => c.label === label);
      if (!bucket) {
        bucket = { label, entries: [] };
        constructs.push(bucket);
      }
      bucket.entries.push(e);
    }
    // Re-order buckets into the canonical construct order (declaration order need not match display).
    constructs.sort((a, b) => (order.get(a.label) ?? 0) - (order.get(b.label) ?? 0));
    return { context: g.context, contextEntry, constructs };
  });
}

/** The construct tallies of a single context group — the one source for both the counts strip and {@link countsByContext}. */
export function countsForGroup(group: ContextGroup): ConstructCount[] {
  return group.constructs.map((c) => ({ label: c.label, count: c.entries.length }));
}

/** Per-context construct tallies, derived from {@link groupByConstruct} (only present buckets). */
export function countsByContext(model: GlossaryModel): { context: string; counts: ConstructCount[] }[] {
  return groupByConstruct(model).map((g) => ({ context: g.context, counts: countsForGroup(g) }));
}

/** The icon slug for a construct label — a stable key for the shape/colour each DDD concept gets in the
 * Explorer (e.g. Entities → a green square, Value Objects → a blue lozenge). See `_model.scss`. */
const CONSTRUCT_SLUG: Record<string, string> = {
  Aggregates: 'aggregate',
  Entities: 'entity',
  'Value Objects': 'value',
  Enumerations: 'enum',
  'Domain Events': 'event',
  'Integration Events': 'integration-event',
  Types: 'type',
  // Behavioural & lifecycle slugs (#453) — `_model.scss` shapes/colours these. Note `state-machine`
  // (the model graph's `states` kind) and the `spec` slug, which shares `--koi-ddd-spec` with the
  // canvas palette's `rule` button rather than forking a separate hue.
  'State Machines': 'state-machine',
  Commands: 'command',
  Queries: 'query',
  'Read Models': 'read-model',
  Policies: 'policy',
  'Domain Services': 'service',
  Repositories: 'repository',
  Factories: 'factory',
  Specifications: 'spec',
};

export function constructSlug(label: string): string {
  return CONSTRUCT_SLUG[label] ?? 'type';
}

/** The singular DDD-construct label for a glossary `kind` — for one element's type tooltip (e.g. `value`
 * → "Value Object"), distinct from {@link CONSTRUCTS}' plural section headings ("Value Objects"). */
const SINGULAR_LABEL_OF_KIND: Record<string, string> = {
  aggregate: 'Aggregate',
  entity: 'Entity',
  value: 'Value Object',
  quantity: 'Value Object',
  enum: 'Enumeration',
  event: 'Domain Event',
  'integration event': 'Integration Event',
  type: 'Type',
  // Behavioural & lifecycle kinds (#453). `states` is the model graph's state-machine kind (NOT
  // "state-machine"); the rest are Phase-2 and not emitted yet, but resolve a singular label now.
  states: 'State Machine',
  command: 'Command',
  query: 'Query',
  'read-model': 'Read Model',
  policy: 'Policy',
  service: 'Domain Service',
  repository: 'Repository',
  factory: 'Factory',
  spec: 'Specification',
};

/**
 * Resolve a glossary `kind` to its Explorer icon `slug` + singular type `label` — the single source the
 * top-bar breadcrumb shares with the navigator, so the same DDD concept wears the same glyph in both.
 */
export function constructForKind(kind: string): { slug: string; label: string } {
  return {
    slug: constructSlug(LABEL_OF_KIND.get(kind) ?? 'Types'),
    label: SINGULAR_LABEL_OF_KIND[kind] ?? 'Type',
  };
}

/** A small shape-coded icon for a DDD construct; the shape + colour live in CSS keyed by `data-construct`.
 *  Exported so the Domain navigator (#453) wears the SAME glyph markup — one source for the icon shape. */
export function constructIcon(slug: string): HTMLElement {
  const icon = document.createElement('span');
  icon.className = 'koi-model-icon';
  icon.dataset.construct = slug;
  icon.setAttribute('aria-hidden', 'true');
  return icon;
}
