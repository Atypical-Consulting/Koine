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
import { groupByContext } from '@/glossary';

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

/** A small count badge, e.g. `Aggregates 1`, used in both the counts strip and construct headers. */
function countBadge(className: string, label: string, count: number): HTMLElement {
  const badge = document.createElement('span');
  badge.className = className;
  const name = document.createElement('span');
  name.className = 'koi-model-count-label';
  name.textContent = label;
  const num = document.createElement('span');
  num.className = 'koi-model-count-num';
  num.textContent = String(count);
  badge.append(name, ' ', num);
  return badge;
}

/** The 1-based start line/column of an entry's name range (the editor's `goto` contract is 1-based). */
function gotoTarget(entry: GlossaryEntry): [line: number, col: number] {
  return [entry.nameRange.start.line + 1, entry.nameRange.start.character + 1];
}

/** Presentation options for {@link renderModelOutline}. Defaults preserve the original single-pane look. */
export interface ModelOutlineOptions {
  /** Render the compact per-context counts strip inside each context (default `true`). The left-rail
   * "Explorateur" passes `false` because the dedicated "Vue d'ensemble" section ({@link renderOverviewCounts})
   * owns the tallies there — so the two sections don't double up. */
  counts?: boolean;
  /** Append the bottom Context Map / Ubiquitous Language nav buttons (default `true`). */
  nav?: boolean;
}

/**
 * Build the model-outline navigator: a per-context counts strip, then construct-grouped leaves, then
 * the top-level Context Map + Ubiquitous Language entries. Clicking a leaf selects the element and
 * jumps to its declaration.
 */
export function renderModelOutline(
  model: GlossaryModel,
  handlers: ModelOutlineHandlers,
  opts: ModelOutlineOptions = {},
): HTMLElement {
  const showCounts = opts.counts ?? true;
  const showNav = opts.nav ?? true;
  const root = document.createElement('div');
  root.className = 'koi-model';

  for (const group of groupByConstruct(model)) {
    root.appendChild(renderContext(group, handlers, showCounts));
  }

  if (showNav) root.appendChild(renderNav(handlers));
  return root;
}

/**
 * The model-wide "Vue d'ensemble" overview: each bounded context with its construct tallies. Shares the
 * one tally source ({@link countsByContext} → {@link countsForGroup}) with the navigator's inline strip,
 * so the left rail's Explorateur and Vue d'ensemble can never disagree on a count.
 */
export function renderOverviewCounts(model: GlossaryModel): HTMLElement {
  const root = document.createElement('div');
  root.className = 'koi-overview';
  for (const { context, counts } of countsByContext(model)) {
    const section = document.createElement('section');
    section.className = 'koi-overview-ctx';
    const head = document.createElement('h4');
    head.className = 'koi-overview-ctx-name';
    head.textContent = context;
    section.appendChild(head);
    const strip = document.createElement('div');
    strip.className = 'koi-overview-counts';
    for (const c of counts) strip.appendChild(countBadge('koi-overview-count', c.label, c.count));
    section.appendChild(strip);
    root.appendChild(section);
  }
  return root;
}

function renderContext(group: ContextGroup, handlers: ModelOutlineHandlers, showCounts: boolean): HTMLElement {
  const section = document.createElement('section');
  section.className = 'koi-model-ctx';

  const header = document.createElement('button');
  header.type = 'button';
  header.className = 'koi-model-ctx-name';
  header.textContent = group.context;
  if (group.contextEntry) {
    const ctx = group.contextEntry;
    header.title = 'Go to context declaration';
    header.addEventListener('click', () => handlers.goto(...gotoTarget(ctx)));
  } else {
    header.disabled = true;
  }
  section.appendChild(header);

  // Compact per-context counts strip (shares countsForGroup with countsByContext — one tally source).
  // Suppressed in the left rail, where the dedicated "Vue d'ensemble" section owns the tallies.
  if (showCounts) {
    const counts = document.createElement('div');
    counts.className = 'koi-model-counts';
    for (const c of countsForGroup(group)) {
      counts.appendChild(countBadge('koi-model-count', c.label, c.count));
    }
    section.appendChild(counts);
  }

  for (const construct of group.constructs) {
    section.appendChild(renderConstruct(construct, handlers));
  }
  return section;
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

/** A small shape-coded icon for a DDD construct; the shape + colour live in CSS keyed by `data-construct`. */
function constructIcon(slug: string): HTMLElement {
  const icon = document.createElement('span');
  icon.className = 'koi-model-icon';
  icon.dataset.construct = slug;
  icon.setAttribute('aria-hidden', 'true');
  return icon;
}

function renderConstruct(construct: ConstructGroup, handlers: ModelOutlineHandlers): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'koi-model-construct';
  const slug = constructSlug(construct.label);

  const head = document.createElement('h4');
  head.className = 'koi-model-construct-name';
  head.append(constructIcon(slug), construct.label, ' ', countSuffix(construct.entries.length));
  wrap.appendChild(head);

  const list = document.createElement('ul');
  list.className = 'koi-model-list';
  for (const entry of construct.entries) {
    const li = document.createElement('li');
    const leaf = document.createElement('button');
    leaf.type = 'button';
    leaf.className = 'koi-model-leaf';
    leaf.dataset.qname = entry.qualifiedName;
    // Icon first, then the name as a text node — keeps leaf.textContent === entry.name.
    leaf.append(constructIcon(slug), entry.name);
    leaf.addEventListener('click', () => {
      handlers.onSelect(entry);
      handlers.goto(...gotoTarget(entry));
    });
    li.appendChild(leaf);
    list.appendChild(li);
  }
  wrap.appendChild(list);
  return wrap;
}

function countSuffix(count: number): HTMLElement {
  const num = document.createElement('span');
  num.className = 'koi-model-construct-num';
  num.textContent = String(count);
  return num;
}

function renderNav(handlers: ModelOutlineHandlers): HTMLElement {
  const nav = document.createElement('div');
  nav.className = 'koi-model-navs';
  nav.appendChild(navButton('contextmap', 'Context Map', handlers.onOpenContextMap));
  nav.appendChild(navButton('glossary', 'Ubiquitous Language', handlers.onOpenGlossary));
  return nav;
}

function navButton(nav: string, label: string, onClick?: () => void): HTMLElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'koi-model-nav';
  btn.dataset.nav = nav;
  btn.textContent = label;
  if (onClick) btn.addEventListener('click', onClick);
  else btn.disabled = true;
  return btn;
}
