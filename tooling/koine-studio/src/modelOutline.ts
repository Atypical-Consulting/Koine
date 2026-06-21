// The DDD-semantic model outline (#142, Task 2): a navigator that groups the model by construct
// within each bounded context — Aggregates / Entities / Value Objects / … — rather than by file.
// Sourced from the glossary model (`koine/glossaryModel`), which already enumerates every concept
// once, in declaration order, with its context, kind, and a name range for jump-to-source. Pure DOM
// builders + pure grouping helpers, mirroring `glossary.ts` so they unit-test under happy-dom.
import type { GlossaryEntry, GlossaryModel, Range } from './lsp';

export interface OutlineHandlers {
  /** Select an element (drives the inspector + cross-highlighting). */
  onSelect(entry: GlossaryEntry): void;
  /** Jump the editor to the declaration's name range. */
  onGoto(range: Range): void;
}

/**
 * Construct display order + labels, keyed by the glossary `kind` (see `GlossaryModelBuilder.KindOf`).
 * The `context` kind is the group identity, never a leaf, so it is intentionally absent here. Any
 * unknown/future kind falls through to a "Other" bucket so nothing silently disappears.
 */
const CONSTRUCTS: readonly { kind: string; label: string }[] = [
  { kind: 'aggregate', label: 'Aggregates' },
  { kind: 'entity', label: 'Entities' },
  { kind: 'value', label: 'Value Objects' },
  { kind: 'quantity', label: 'Quantities' },
  { kind: 'enum', label: 'Enums' },
  { kind: 'event', label: 'Domain Events' },
  { kind: 'integration event', label: 'Integration Events' },
  { kind: 'type', label: 'Types' },
];
const OTHER_LABEL = 'Other';

/** The display label for a glossary kind (stable, used by both grouping and counts). */
function labelFor(kind: string): string {
  return CONSTRUCTS.find((c) => c.kind === kind)?.label ?? OTHER_LABEL;
}

/** The order index a label sorts at (unknown labels sort last, before "Other"). */
function labelOrder(label: string): number {
  const i = CONSTRUCTS.findIndex((c) => c.label === label);
  return i === -1 ? CONSTRUCTS.length : i;
}

export interface ConstructGroup {
  kind: string;
  label: string;
  entries: GlossaryEntry[];
}
export interface ContextGroup {
  context: string;
  constructs: ConstructGroup[];
}

/**
 * Group entries by owning context (declaration order preserved), then by construct within each
 * context (in {@link CONSTRUCTS} order). The synthetic `context` entries are dropped — they name the
 * group, they are not leaves — and empty construct buckets are omitted.
 */
export function groupByConstruct(entries: GlossaryEntry[]): ContextGroup[] {
  const groups: ContextGroup[] = [];
  const byContext = new Map<string, GlossaryEntry[]>();
  for (const e of entries) {
    if (e.kind === 'context') {
      if (!byContext.has(e.context)) {
        byContext.set(e.context, []);
        groups.push({ context: e.context, constructs: [] });
      }
      continue;
    }
    let list = byContext.get(e.context);
    if (!list) {
      list = [];
      byContext.set(e.context, list);
      groups.push({ context: e.context, constructs: [] });
    }
    list.push(e);
  }

  for (const group of groups) {
    const members = byContext.get(group.context) ?? [];
    const byLabel = new Map<string, ConstructGroup>();
    for (const e of members) {
      const label = labelFor(e.kind);
      let cg = byLabel.get(label);
      if (!cg) {
        cg = { kind: e.kind, label, entries: [] };
        byLabel.set(label, cg);
      }
      cg.entries.push(e);
    }
    group.constructs = Array.from(byLabel.values()).sort((a, b) => labelOrder(a.label) - labelOrder(b.label));
  }
  return groups;
}

export interface ContextCounts {
  context: string;
  counts: { label: string; count: number }[];
}

/** Per-context tallies of each construct (in {@link CONSTRUCTS} order), omitting zero counts. */
export function countsByContext(entries: GlossaryEntry[]): ContextCounts[] {
  return groupByConstruct(entries).map((g) => ({
    context: g.context,
    counts: g.constructs.map((c) => ({ label: c.label, count: c.entries.length })),
  }));
}

/** Builds the model outline: bounded contexts, each with construct sub-headers and selectable leaves. */
export function renderModelOutline(model: GlossaryModel, handlers: OutlineHandlers): HTMLElement {
  const root = document.createElement('div');
  root.className = 'koi-outline';

  const contextEntries = new Map<string, GlossaryEntry>();
  for (const e of model.entries) {
    if (e.kind === 'context') contextEntries.set(e.context, e);
  }

  const groups = groupByConstruct(model.entries);
  if (groups.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'koi-outline-empty muted';
    empty.textContent = 'No model symbols (the model may be empty or have syntax errors).';
    root.appendChild(empty);
    return root;
  }

  for (const group of groups) {
    const section = document.createElement('section');
    section.className = 'koi-outline-ctx';

    const header = document.createElement('button');
    header.type = 'button';
    header.className = 'koi-outline-ctx-head';
    header.textContent = group.context;
    const ctxEntry = contextEntries.get(group.context);
    if (ctxEntry) {
      header.title = 'Go to context';
      header.addEventListener('click', () => {
        handlers.onSelect(ctxEntry);
        handlers.onGoto(ctxEntry.nameRange);
      });
    } else {
      header.disabled = true;
    }
    section.appendChild(header);

    for (const construct of group.constructs) {
      const sub = document.createElement('div');
      sub.className = 'koi-outline-construct';
      const subHead = document.createElement('span');
      subHead.className = 'koi-outline-construct-head';
      subHead.textContent = `${construct.label} (${construct.entries.length})`;
      sub.appendChild(subHead);

      for (const e of construct.entries) {
        const leaf = document.createElement('button');
        leaf.type = 'button';
        leaf.className = 'koi-outline-leaf';
        leaf.textContent = e.name;
        leaf.title = e.qualifiedName;
        leaf.setAttribute('data-qname', e.qualifiedName);
        leaf.addEventListener('click', () => {
          handlers.onSelect(e);
          handlers.onGoto(e.nameRange);
        });
        sub.appendChild(leaf);
      }
      section.appendChild(sub);
    }
    root.appendChild(section);
  }
  return root;
}
