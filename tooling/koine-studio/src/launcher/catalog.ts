// The Spotlight launcher's catalog model — pure types + constants, DOM-free. Ported from
// design/design_handoff_git_spotlight_logos/koine-launcher.js's `MODES` / `PREFIX_CHARS` / `GROUPS` /
// `KIND`. One deliberate adaptation from the prototype (see scratchpad/SEAMS.md): the prototype keys
// integration events as "integration", but the real glossary `kind` string emitted by the LSP is
// "integration-event" — KIND below is keyed by the real kind, not the prototype's shorthand, so later
// tasks can look a glossary/model-index entry's `kind` straight up without a translation step.
import type { ConceptSlug } from '@/model/conceptColors.generated';
import type { Range } from '@/lsp/lsp';
import type { ModelElement, StateTransition } from '@/model/modelIndex';

/** The seven result categories a catalog entry can belong to. */
export type Category = 'action' | 'symbol' | 'event' | 'rule' | 'file' | 'glossary' | 'commit';

/**
 * One row in the launcher's catalog. Kept minimal for this task — the ranker (`rank` in fuzzy.ts)
 * only reads `title`, `keywords`, `ctx`, `sub` and `cat`. The remaining fields are hooks later tasks
 * need (file/commit identity, the live-preview builder, the quick-action binding) and are typed
 * loosely on purpose since those tasks define their exact shape.
 */
export interface CatalogEntry {
  id: string;
  cat: Category;
  /** A DDD concept slug (see `KIND`) when this entry is a domain symbol/event; a plain string otherwise. */
  kind?: ConceptSlug | string;
  title: string;
  sub?: string;
  ctx?: string;
  keywords?: string;
  /** Workspace-relative file path (files, and symbols/events sourced from a file). */
  file?: string;
  /** Commit sha (commit-category entries). */
  hash?: string;
  /** Rule sub-kind: `'rule'` (an invariant), `'state'` (an enum member), or `'transition'` (a real
   * declared guarded state-machine edge, #1163) — rule-category entries. */
  rkind?: string;
  /** Hook for a later task's live-preview pane; deliberately loose until that task defines its shape. */
  preview?: () => unknown;
  /** Hook for a later task's per-result quick-action binding; deliberately loose until that task lands. */
  actionKey?: string;

  // --- carry-through fields added by the live catalog builder (buildCatalog.ts, #1143) ---------
  // Additive and optional so Task 1's tests are untouched; each is the identity a later task (5/6/8)
  // needs to act on the entry without re-deriving it from the title/sub strings.
  /** The glossary-entry qualified name (symbol/event/glossary entries): the selection/preview key. */
  qualifiedName?: string;
  /** The declaration name's source range (symbol/event entries): jump-to-source (Task 6). */
  nameRange?: Range;
  /** The bound `Command.id` (action entries): what `registry.run(...)` dispatches (Tasks 6/8). */
  cmdId?: string;
  /** The command's keyboard-chord hint, e.g. `⌘N` (action entries), shown alongside the title. */
  hint?: string;
  /** The declaration's `///` doc text (glossary entries): the live-preview pane's body (Task 5). */
  doc?: string | null;
  /** The commit's author-date, ISO-8601 (commit entries): the live-preview pane's "When" row (Task 5). */
  date?: string;
  /**
   * The already-joined `ModelElement` (symbol/event/rule entries): carried straight through from
   * `buildCatalog`'s `ModelIndex.byQn` iteration so the live-preview pane (Task 5) can render a rich
   * preview without a second `modelIndex()` round-trip.
   */
  element?: ModelElement;
  /**
   * The structured declared guarded edge (`rkind === 'transition'` rule entries, #1163): carried so the
   * live-preview pane renders `from → to` plus guard/trigger straight off the entry — never an edge
   * inferred from enum-member order (#1145).
   */
  transition?: StateTransition;
}

/** A prefix-switchable search mode (`>`, `@`, `#`, `/`, `:`, or the no-prefix "all"). */
export interface LauncherMode {
  key: string;
  prefix: string;
  label: string;
  hint: string;
  /** When set, only pool entries whose `cat` is in this list are shown. Omitted ⇒ every category. */
  cats?: Category[];
}

/** Prefix modes, keyed by their prefix char (`MODES.all` is the no-prefix default). */
export const MODES: Record<string, LauncherMode> = {
  all: { key: 'all', prefix: '', label: 'All', hint: 'everything' },
  '>': { key: '>', prefix: '>', label: 'Commands', hint: 'run a command', cats: ['action'] },
  '@': { key: '@', prefix: '@', label: 'Symbols', hint: 'go to a domain symbol', cats: ['symbol'] },
  '#': { key: '#', prefix: '#', label: 'Events', hint: 'find an event', cats: ['event'] },
  '/': { key: '/', prefix: '/', label: 'Files', hint: 'open a file', cats: ['file'] },
  ':': { key: ':', prefix: ':', label: 'Glossary', hint: 'look up a term', cats: ['glossary'] },
};

/** The recognized mode-switch prefix characters, in the order the footer/hint bar lists them. */
export const PREFIX_CHARS: string[] = ['>', '@', '#', '/', ':'];

/** Result-list group order + section labels, keyed by category. */
export const GROUPS: [Category, string][] = [
  ['action', 'Commands'],
  ['symbol', 'Domain symbols'],
  ['event', 'Events'],
  ['rule', 'Rules & states'],
  ['file', 'Files'],
  ['glossary', 'Glossary'],
  ['commit', 'Recent commits'],
];

/** A DDD kind's launcher chip: 2-letter code, human-readable word, and its `--koi-ddd-<slug>` token. */
export interface KindMeta {
  code: string;
  word: string;
  token: string;
}

/**
 * DDD kind → chip code + human word, keyed by the real glossary `kind` string (a `ConceptSlug`). Only
 * the kinds the launcher renders a chip for are present — reuses `ConceptSlug` for the keys (ADR 0004)
 * rather than re-hardcoding the prototype's own kind strings. The `--koi-ddd-*` token is deliberately
 * NOT stored here — it's derived from the key below (issue #1162) so it can never desync from it.
 */
const KIND_META: Partial<Record<ConceptSlug, Omit<KindMeta, 'token'>>> = {
  aggregate: { code: 'AR', word: 'aggregate root' },
  entity: { code: 'EN', word: 'entity' },
  value: { code: 'VO', word: 'value object' },
  enum: { code: 'EM', word: 'enum' },
  service: { code: 'SV', word: 'domain service' },
  repository: { code: 'RP', word: 'repository' },
  command: { code: 'CM', word: 'command' },
  query: { code: 'QY', word: 'query' },
  event: { code: 'EV', word: 'domain event' },
  'integration-event': { code: 'IE', word: 'integration event' },
};

/**
 * DDD kind → full chip metadata, built from {@link KIND_META} by deriving each entry's
 * `--koi-ddd-<slug>` token from its own key (issue #1162) — the literal can never drift from the slug
 * it's supposed to color.
 */
export const KIND: Partial<Record<ConceptSlug, KindMeta>> = Object.fromEntries(
  // The explicit `[ConceptSlug, KindMeta]` return annotation (not just the outer `as` below) makes
  // TypeScript check `{ ...meta, token: ... }` against `KindMeta`'s exact shape — so a dropped/renamed
  // field here is a compile error, not just a runtime one caught by catalog.test.ts's guard.
  Object.entries(KIND_META).map(([slug, meta]): [ConceptSlug, KindMeta] => [
    slug as ConceptSlug,
    { ...meta, token: `--koi-ddd-${slug}` },
  ]),
) as Partial<Record<ConceptSlug, KindMeta>>;

/**
 * Resolve a raw launcher input to its mode + the query with the prefix stripped. `input[0]` being one
 * of `PREFIX_CHARS` switches to that mode (a single leading space left after stripping is trimmed);
 * anything else stays in `MODES.all` with the input unchanged.
 */
export function parseMode(input: string): { mode: LauncherMode; query: string } {
  const prefixChar = input[0];
  if (prefixChar && PREFIX_CHARS.includes(prefixChar)) {
    const rest = input.slice(1);
    const query = rest.startsWith(' ') ? rest.slice(1) : rest;
    return { mode: MODES[prefixChar], query };
  }
  return { mode: MODES.all, query: input };
}
