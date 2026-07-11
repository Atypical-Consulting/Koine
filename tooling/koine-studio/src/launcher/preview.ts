// The Spotlight launcher's live PREVIEW pane data (issue #1143, task 5): 8 pure, DOM-free builders
// that map REAL model/git data to a `PreviewViewModel` — plain data `PreviewPane.tsx` renders with
// Preact (no innerHTML/dangerouslySet). Ported from the 8 `*Preview` builders in
// design/design_handoff_git_spotlight_logos/koine-launcher.js, which took hand-authored demo data and
// returned innerHTML strings; these take the real typed seams instead (`ModelElement`, `GlossaryEntry`,
// `GitLogEntry`) and degrade gracefully — never fabricating the prototype's demo strings — when the
// live data doesn't carry a given field. See scratchpad/task-5-report.md for the per-builder gap list.
//
// Import discipline (enforced by preview.test.ts, mirroring buildCatalog.test.ts): every value import
// stays inside `@/launcher/`; everything from the lsp/host/model seams is `import type` only.
import type { ModelElement } from '@/model/modelIndex';
import type { ModelMember } from '@/lsp/lsp';
import type { GitLogEntry } from '@/host/types';
import { KIND, relPathOf, type CatalogEntry } from '@/launcher/catalog';
import { normalizeKind } from '@/launcher/buildCatalog';

/** The result card's icon: either a DDD chip (`chipSlug`, symbol/event/rule kinds) or a line-icon
 * glyph (`glyph`, everything else) — the same split `ResultRow.tsx` renders for the result list. */
export interface PreviewHeader {
  chipSlug?: string;
  glyph?: string;
  name: string;
  sub: string;
}

/** A single invariant/business rule: `message` is only ever set when the live data separates the
 * condition from its failure message (today's `DiagramNode.invariants` never does — see rulePreview). */
export interface PreviewRule {
  kind: string;
  expr: string;
  message?: string;
}

export interface PreviewTransition {
  from: string;
  to: string;
  /** The declared guard condition, when the edge has one (`when <guard>`). */
  guard?: string;
  /** The declared triggering command, when the edge has one (`via <cmd>()`). */
  via?: string;
}

export interface PreviewDiffLine {
  sign: '+' | '-' | ' ';
  text: string;
}

export interface PreviewCommitFile {
  status: string;
  path: string;
  stat?: string;
}

/** The live-preview pane's plain-data view model. Exactly one "category extra" (states/payloadFields/
 * diff/glossaryPills/rule/transition/commitFiles) is populated per concrete builder; the rest stay
 * undefined so `PreviewPane.tsx` only renders the sections a given result actually has data for. */
export interface PreviewViewModel {
  header: PreviewHeader;
  filePath?: string;
  codeLines?: string[];
  meta?: [string, string][];
  /** Free-form description/definition body (a glossary term's `///` doc text). */
  desc?: string;
  states?: string[];
  payloadFields?: [string, string][];
  diff?: PreviewDiffLine[];
  glossaryPills?: string[];
  rule?: PreviewRule;
  transition?: PreviewTransition;
  commitFiles?: PreviewCommitFile[];
  note?: string;
}

const wordFor = (kind: string): string => KIND[kind as keyof typeof KIND]?.word ?? kind;

/** A basename off a workspace-relative path OR a `file://` uri — both use `/` as the separator. */
function basename(path: string): string {
  const clean = path.split(/[?#]/)[0];
  const slash = clean.lastIndexOf('/');
  return slash === -1 ? clean : clean.slice(slash + 1);
}

/** Best-effort `<file> · line <n>` from a `DiagramNode`'s raw source span; omitted when the element
 * carries no diagram node (a value/enum referenced but never drawn) or the node has no position. */
function filePathFor(node: ModelElement['node']): string | undefined {
  const span = node?.sourceSpan;
  if (!span?.file) return undefined;
  return `${basename(span.file)} · line ${span.line}`;
}

/** The class-body-shaped rows a code block renders: `field` members for everything, `enumMember`
 * members for an enum (its own member kind — enums never carry `field`s). */
function membersForCode(kind: string, members: ModelMember[] | undefined): ModelMember[] {
  if (!members) return [];
  return members.filter((m) => (kind === 'enum' ? m.kind === 'enumMember' : m.kind === 'field'));
}

/** Synthesizes a minimal, honest code block from real members: `<kind> <Name> { <name>: <type> [=
 * <value>] … }`. Not Koine's actual declaration grammar (that needs full re-parsing this pane doesn't
 * do) — just a data-driven, testable rendering of what the model index actually reports. */
function codeBlockFor(kind: string, name: string, members: ModelMember[]): string[] {
  const body = members.map((m) => {
    const type = m.type ? `: ${m.type}` : '';
    const value = m.value ? ` = ${m.value}` : '';
    return `  ${m.name}${type}${value}`;
  });
  return [`${kind} ${name} {`, ...body, '}'];
}

function statesFor(members: ModelMember[] | undefined): string[] | undefined {
  const names = (members ?? []).filter((m) => m.kind === 'enumMember').map((m) => m.name);
  return names.length ? names : undefined;
}

/**
 * A domain symbol (aggregate/entity/value/enum/service/repository/command/query): DDD chip header,
 * a code block synthesized from its real `modelMembers`, a meta grid (Kind/Context/Members/Invariants),
 * an enum's state list, and its `///` doc (if any) as a note. Degrades by omitting whatever isn't
 * derivable: no `node` ⇒ no filePath; no members ⇒ no code block; no invariants ⇒ no Invariants row.
 */
export function symbolPreview(el: ModelElement): PreviewViewModel {
  const { entry, node, modelMembers } = el;
  const kind = normalizeKind(entry.kind);
  const fields = membersForCode(kind, modelMembers);

  const meta: [string, string][] = [
    ['Kind', wordFor(kind)],
    ['Context', entry.context],
  ];
  if (fields.length) meta.push(['Members', `${fields.length} field${fields.length === 1 ? '' : 's'}`]);
  if (node?.invariants?.length) meta.push(['Invariants', String(node.invariants.length)]);

  return {
    header: { chipSlug: kind, name: entry.name, sub: `${wordFor(kind)} · ${entry.context}` },
    filePath: filePathFor(node),
    codeLines: fields.length ? codeBlockFor(kind, entry.name, fields) : undefined,
    meta,
    states: kind === 'enum' ? statesFor(modelMembers) : undefined,
    note: entry.doc ?? undefined,
  };
}

/**
 * A domain/integration event: DDD chip header, its payload fields (from `modelMembers`), a small meta
 * grid, and its `///` doc as a note. Degrades by omitting `payloadFields` when the event carries no
 * field members (an event referenced but never drawn with a class body).
 */
export function eventPreview(el: ModelElement): PreviewViewModel {
  const { entry, node, modelMembers } = el;
  const kind = normalizeKind(entry.kind);
  const fields = (modelMembers ?? []).filter((m) => m.kind === 'field');

  return {
    header: { chipSlug: kind, name: entry.name, sub: `${wordFor(kind)} · ${entry.context}` },
    filePath: filePathFor(node),
    payloadFields: fields.length ? fields.map((f): [string, string] => [f.name, f.type ?? '']) : undefined,
    meta: [
      ['Kind', wordFor(kind)],
      ['Context', entry.context],
    ],
    note: entry.doc ?? undefined,
  };
}

export interface ActionInput {
  title: string;
  sub?: string;
  hint?: string;
}

/** A launcher/command-palette action: no live description exists on `Command` (title/hint/group only),
 * so the meta grid only ever carries the keyboard shortcut, when one is bound. */
export function actionPreview(cmd: ActionInput): PreviewViewModel {
  const meta: [string, string][] = [];
  if (cmd.hint) meta.push(['Shortcut', cmd.hint]);
  return {
    header: { glyph: 'action', name: cmd.title, sub: cmd.sub ?? 'command' },
    meta: meta.length ? meta : undefined,
    note: 'Press ↵ to run.',
  };
}

export interface FileInput {
  relPath: string;
  diff?: PreviewDiffLine[];
}

/**
 * A workspace file. `diff` is only ever populated by a caller that already has unified-diff lines to
 * hand it — no launcher seam (`GitLogEntry`, `GitFile`) exposes per-file diff hunks today, so a plain
 * file result always degrades to the "open to view" note instead of a fabricated code preview.
 */
export function filePreview(file: FileInput): PreviewViewModel {
  const slash = file.relPath.lastIndexOf('/');
  const base = slash === -1 ? file.relPath : file.relPath.slice(slash + 1);
  const dir = slash === -1 ? '' : file.relPath.slice(0, slash);
  return {
    header: { glyph: 'file', name: base, sub: dir },
    filePath: file.relPath,
    diff: file.diff,
    note: file.diff ? undefined : 'Open the file to view its contents.',
  };
}

/** What `glossPreview` actually reads off a glossary term — narrower than the full `GlossaryEntry`
 * (id/kind/context/nameRange aren't used) so `previewFor` can build it straight from a `CatalogEntry`'s
 * own `title`/`doc` carry-through fields, with no second lookup. A full `GlossaryEntry` satisfies this
 * structurally, so existing callers with the richer type need no changes. */
export interface GlossInput {
  name: string;
  doc: string | null;
}

/**
 * A ubiquitous-language glossary term: its `///` doc as the definition, or a fallback note when
 * undocumented. `glossaryPills` ("appears in") is never populated — the launcher carries no
 * reverse-reference list of the types/contexts that use a term, and no seam supplies one (documented
 * gap; a real "appears in" pane needs a fuller cross-reference index than #142's `ModelIndex` built).
 */
export function glossPreview(entry: GlossInput): PreviewViewModel {
  return {
    header: { glyph: 'gloss', name: entry.name, sub: 'ubiquitous language' },
    desc: entry.doc ?? undefined,
    note: entry.doc ? undefined : 'No documentation yet — add a /// comment to define this term.',
  };
}

export interface RuleInput {
  expr: string;
  owner: string;
  ctx?: string;
}

/**
 * An invariant/business rule. `rule.message` is deliberately never set: `DiagramNode.invariants` (the
 * only live source, see buildCatalog.ts's ruleEntries) is a single descriptive string per invariant —
 * there is no separate structured "failure message" to split out of it.
 */
export function rulePreview(input: RuleInput): PreviewViewModel {
  return {
    header: { glyph: 'rule', name: input.owner, sub: input.ctx ? `invariant · ${input.ctx}` : 'invariant' },
    rule: { kind: 'invariant', expr: input.expr },
    meta: [['Enforced on', input.owner]],
  };
}

export interface TransitionInput {
  from: string;
  to: string;
  owner?: string;
  guard?: string;
  via?: string;
}

/** A state-machine transition builder, driven by REAL declared guarded-edge data (#1163): the
 * `from → to` states plus the edge's guard/trigger when it declares them. It is deliberately NOT called
 * for enum-state entries, which only know a flat member list and must not fabricate an edge from
 * declaration order (#1145 review). Optional keys (`guard`/`via`) are only ever set when present, so a
 * guardless/triggerless edge yields a bare `{ from, to }` transition. */
export function transitionPreview(input: TransitionInput): PreviewViewModel {
  const transition: PreviewTransition = { from: input.from, to: input.to };
  if (input.guard) transition.guard = input.guard;
  if (input.via) transition.via = input.via;

  const meta: [string, string][] = [];
  // The owner is the entity/type that DECLARES the state machine — not necessarily the aggregate (an
  // `aggregate Sales root Order` surfaces its transitions on the `Order` entity), so label it neutrally.
  if (input.owner) meta.push(['Owner', input.owner]);
  if (input.guard) meta.push(['Guard', input.guard]);
  if (input.via) meta.push(['Via', input.via]);

  return {
    header: {
      glyph: 'state',
      name: `${input.from} → ${input.to}`,
      sub: input.owner ? `state transition · ${input.owner}` : 'state transition',
    },
    transition,
    meta: meta.length ? meta : undefined,
  };
}

/**
 * A git commit. `commitFiles` is never populated: `GitLogEntry` (the only data `Platform.gitLog`
 * returns) carries `sha`/`author`/`date`/`message` only — no per-commit changed-file list — so a real
 * "Files changed" section would need a second host call this launcher doesn't have a seam for yet.
 */
export function commitPreview(commit: GitLogEntry): PreviewViewModel {
  return {
    header: { glyph: 'commit', name: commit.message, sub: 'commit' },
    meta: [
      ['Commit', commit.sha.slice(0, 7)],
      ['Author', commit.author],
      ['When', commit.date.slice(0, 10)],
    ],
    note: 'File-level changes are not available from the git log summary.',
  };
}

/**
 * `previewFor`'s rkind==='state' branch: the HONEST state-list view for an ENUM member — the selected
 * state and the enum's full declared member set. It never synthesizes a `{ from, to }` transition from
 * declaration order: an "A → B" edge inferred from enum-member order would fabricate domain semantics
 * the model can't derive (#1145 review). Real guarded transitions ARE surfaced now (#1163), but as their
 * own `rkind==='transition'` entries routed to `transitionPreview` — never from this enum-state view.
 */
function statePreview(entry: CatalogEntry, element: ModelElement): PreviewViewModel {
  const allStates = statesFor(element.modelMembers) ?? [];
  return {
    header: { chipSlug: 'enum', name: entry.title, sub: `state · ${element.entry.name}` },
    states: allStates.length ? allStates : undefined,
    note: 'A declared state of this enum. Its guarded transitions are listed as their own entries.',
  };
}


/**
 * Optional OVERRIDES for a selected result's preview data — every field defaults to whatever the
 * matching `CatalogEntry` already carries (its `element` for symbol/event/rule, or its own
 * title/sub/hint/file/doc fields for action/file/glossary/commit), so a real caller (`LauncherPanel`)
 * can call `previewFor(entry, {})` with no resolution step of its own: `buildCatalog` already joined
 * everything a preview needs at catalog-build time. Tests use these overrides to exercise a builder
 * against a hand-built fixture without constructing a full `CatalogEntry.element`.
 */
export interface PreviewContext {
  element?: ModelElement;
  commit?: GitLogEntry;
  glossary?: GlossInput;
  command?: ActionInput;
  file?: FileInput;
}

/**
 * Dispatches a selected `CatalogEntry` to its builder by `cat` (and `rkind` for rule vs. state/
 * transition). Every category prefers its `ctx` override, falling back to the entry's own carry-
 * through data; returns `null` only when NEITHER source has anything to preview (an unresolved
 * symbol/event/rule whose `element` join came up empty, or a file/commit entry missing its identity).
 */
export function previewFor(entry: CatalogEntry, ctx: PreviewContext): PreviewViewModel | null {
  switch (entry.cat) {
    case 'symbol': {
      const element = ctx.element ?? entry.element;
      return element ? symbolPreview(element) : null;
    }
    case 'event': {
      const element = ctx.element ?? entry.element;
      return element ? eventPreview(element) : null;
    }
    case 'action':
      return actionPreview(ctx.command ?? { title: entry.title, sub: entry.sub, hint: entry.hint });
    case 'file': {
      if (ctx.file) return filePreview(ctx.file);
      if (!entry.file) return null;
      return filePreview({ relPath: relPathOf(entry) });
    }
    case 'glossary':
      return glossPreview(ctx.glossary ?? { name: entry.title, doc: entry.doc ?? null });
    case 'rule': {
      const element = ctx.element ?? entry.element;
      if (!element) return null;
      if (entry.rkind === 'transition' && entry.transition) {
        const t = entry.transition;
        return transitionPreview({ from: t.from, to: t.to, guard: t.guard, via: t.via, owner: element.entry.name });
      }
      if (entry.rkind === 'state') return statePreview(entry, element);
      return rulePreview({ expr: entry.title, owner: element.entry.name, ctx: element.entry.context });
    }
    case 'commit': {
      const commit = ctx.commit ?? (entry.hash && entry.date ? { sha: entry.hash, author: entry.ctx ?? '', date: entry.date, message: entry.title } : undefined);
      return commit ? commitPreview(commit) : null;
    }
    default:
      return null;
  }
}
