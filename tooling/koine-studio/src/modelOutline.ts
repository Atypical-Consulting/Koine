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
import type { GlossaryEntry, GlossaryModel } from './lsp';

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
  const groups: ContextGroup[] = [];
  const byContext = new Map<string, ContextGroup>();

  for (const e of model.entries) {
    let group = byContext.get(e.context);
    if (!group) {
      group = { context: e.context, contextEntry: null, constructs: [] };
      byContext.set(e.context, group);
      groups.push(group);
    }
    if (e.kind === 'context') {
      group.contextEntry ??= e;
      continue;
    }
    const label = LABEL_OF_KIND.get(e.kind) ?? 'Types';
    let bucket = group.constructs.find((c) => c.label === label);
    if (!bucket) {
      bucket = { label, entries: [] };
      group.constructs.push(bucket);
    }
    bucket.entries.push(e);
  }

  // Re-order each context's buckets into the canonical construct order (input order is declaration
  // order, which need not match the display order).
  const order = new Map(CONSTRUCTS.map((c, i) => [c.label, i] as const));
  for (const group of groups) {
    group.constructs.sort((a, b) => (order.get(a.label) ?? 0) - (order.get(b.label) ?? 0));
  }
  return groups;
}

/** Per-context construct tallies, derived from {@link groupByConstruct} (only present buckets). */
export function countsByContext(model: GlossaryModel): { context: string; counts: ConstructCount[] }[] {
  return groupByConstruct(model).map((g) => ({
    context: g.context,
    counts: g.constructs.map((c) => ({ label: c.label, count: c.entries.length })),
  }));
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

/**
 * Build the model-outline navigator: a per-context counts strip, then construct-grouped leaves, then
 * the top-level Context Map + Ubiquitous Language entries. Clicking a leaf selects the element and
 * jumps to its declaration.
 */
export function renderModelOutline(model: GlossaryModel, handlers: ModelOutlineHandlers): HTMLElement {
  const root = document.createElement('div');
  root.className = 'koi-model';

  for (const group of groupByConstruct(model)) {
    root.appendChild(renderContext(group, handlers));
  }

  root.appendChild(renderNav(handlers));
  return root;
}

function renderContext(group: ContextGroup, handlers: ModelOutlineHandlers): HTMLElement {
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

  // Compact per-context counts strip.
  const counts = document.createElement('div');
  counts.className = 'koi-model-counts';
  for (const c of group.constructs) {
    counts.appendChild(countBadge('koi-model-count', c.label, c.entries.length));
  }
  section.appendChild(counts);

  for (const construct of group.constructs) {
    section.appendChild(renderConstruct(construct, handlers));
  }
  return section;
}

function renderConstruct(construct: ConstructGroup, handlers: ModelOutlineHandlers): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'koi-model-construct';

  const head = document.createElement('h4');
  head.className = 'koi-model-construct-name';
  head.append(construct.label, ' ', countSuffix(construct.entries.length));
  wrap.appendChild(head);

  const list = document.createElement('ul');
  list.className = 'koi-model-list';
  for (const entry of construct.entries) {
    const li = document.createElement('li');
    const leaf = document.createElement('button');
    leaf.type = 'button';
    leaf.className = 'koi-model-leaf';
    leaf.dataset.qname = entry.qualifiedName;
    leaf.textContent = entry.name;
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
