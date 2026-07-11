// Builds the Spotlight launcher's live catalog (issue #1143 task 2) by joining the workspace's real
// model index, command registry, open/workspace files, glossary, and git history into the pure
// `CatalogEntry[]` shape `rank()` (fuzzy.ts) scores. This module is a PURE JOIN: every live surface is
// injected via `LauncherSources` (constructed in the shell, Task 8) so it never value-imports the live
// LSP client class, a concrete host implementation, or anything under the shell — only types, plus
// the pure `catalog` module. That keeps it unit-testable with hand-built fakes (buildCatalog.test.ts)
// and matches the imperative-mount / dependency-injected-controller idiom the rest of the shell
// already uses (see scratchpad/SEAMS.md "Imperative mount pattern").
import type { Command } from '@atypical/koine-ui';
import type { ModelIndex } from '@/model/modelIndex';
import type { GlossaryEntry } from '@/lsp/lsp';
import type { GitLogEntry } from '@/host/types';
import { KIND, type CatalogEntry } from '@/launcher/catalog';
import { normalizeDddKind } from '@/model/dddKind';

/**
 * Everything `buildCatalog` needs, injected by the shell (Task 8) so this module stays a pure join
 * with no knowledge of the live LSP client, host platform, or the DOM. `files()` is pre-merged (open
 * buffers + workspace files, de-duped) by the caller; `gitLog` is `null` when the host has no git at
 * all, and `canUseGit` gates the whole commits group even if a stale non-null `gitLog` were ever passed.
 */
export interface LauncherSources {
  modelIndex(): Promise<ModelIndex>;
  commands(): Command[];
  files(): { uri: string; relPath: string }[];
  gitLog(): Promise<GitLogEntry[]> | null;
  canUseGit: boolean;
  glossary(): GlossaryEntry[];
}

// The DDD kinds (after `normalizeKind`) that read as a domain "symbol" — everything KIND has a chip
// for except the two event kinds, which get their own category below.
const SYMBOL_KINDS = new Set(['aggregate', 'entity', 'value', 'enum', 'service', 'repository', 'command', 'query']);
const EVENT_KINDS = new Set(['event', 'integration-event']);

/**
 * Normalize a raw glossary `kind` string to the slug `KIND` (catalog.ts) and the category split key
 * on. A thin alias of the canonical `@/model/dddKind` fold (issue #1162) — kept under this name
 * because `src/launcher/preview.ts` and this module's own tests import `normalizeKind` from here.
 * `src/model/inspector.ts`'s `constructKey()` delegates to the same canonical fold, so the two call
 * sites can no longer drift. Every kind the fold doesn't alias (including the still-unrouted
 * service/repository/command/query noted in scratchpad/SEAMS.md) passes through unchanged.
 */
export const normalizeKind = normalizeDddKind;

/** Joins the given parts with a space and lowercases the result; falsy parts are dropped. */
function keywordsOf(...parts: (string | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ').toLowerCase();
}

/**
 * Symbols ← every non-event DDD-typed glossary entry (aggregate/entity/value/enum/service/repository/
 * command/query — never `context`, which `buildModelIndex` already excludes from `byQn`). Events ←
 * `event`/`integration-event` entries, same field treatment, different category. One pass over
 * `byQn` classifies each element into at most one of the two.
 */
function symbolAndEventEntries(index: ModelIndex): CatalogEntry[] {
  const out: CatalogEntry[] = [];
  for (const element of index.byQn.values()) {
    const { entry } = element;
    const kind = normalizeKind(entry.kind);
    const cat = SYMBOL_KINDS.has(kind) ? 'symbol' : EVENT_KINDS.has(kind) ? 'event' : null;
    if (!cat) continue; // an entry kind this launcher doesn't chip (e.g. the "type" fallback) — skip, don't invent one
    out.push({
      id: `${cat === 'symbol' ? 'sym' : 'evt'}:${entry.qualifiedName}`,
      cat,
      kind,
      title: entry.name,
      sub: KIND[kind as keyof typeof KIND]?.word ?? entry.kind,
      ctx: entry.context,
      keywords: keywordsOf(entry.name, entry.context, entry.doc),
      qualifiedName: entry.qualifiedName,
      nameRange: entry.nameRange,
      // The already-joined `ModelElement` (issue #1143, task 5): carried straight through so the live-
      // preview pane can build a symbol/event preview without a second `modelIndex()` round-trip — this
      // loop already has it in hand from the `byQn` join.
      element,
    });
  }
  return out;
}

/**
 * Rules & states ← whatever the joined `ModelIndex` actually exposes for a domain element: an
 * aggregate/value/entity's `invariants`, an enum's `enumMember` states, and an aggregate/entity's real
 * declared guarded state transitions (`element.transitions`, the owner-attached #1163 projection).
 * Every edge listed here is a DECLARED one — the transitions come off the owner element that projects
 * them, never inferred from enum-member adjacency or declaration order (the approximation #1145 removed).
 */
function ruleEntries(index: ModelIndex): CatalogEntry[] {
  const out: CatalogEntry[] = [];
  for (const element of index.byQn.values()) {
    const { entry, node, modelMembers } = element;
    const kind = normalizeKind(entry.kind);

    (node?.invariants ?? []).forEach((invariant, i) => {
      out.push({
        id: `rule:${entry.qualifiedName}:inv:${i}`,
        cat: 'rule',
        rkind: 'rule',
        kind,
        title: invariant,
        sub: `${entry.name} invariant`,
        ctx: entry.context,
        keywords: keywordsOf(invariant, entry.name),
        // Carries the OWNING element's qualifiedName + the element itself (not a per-invariant
        // identity — there isn't one) so the live-preview pane (Task 5) can render this invariant's
        // owner without a second `modelIndex()` round-trip.
        qualifiedName: entry.qualifiedName,
        element,
      });
    });

    if (kind === 'enum') {
      for (const member of modelMembers ?? []) {
        if (member.kind !== 'enumMember') continue;
        out.push({
          id: `rule:${entry.qualifiedName}:state:${member.name}`,
          cat: 'rule',
          rkind: 'state',
          kind,
          title: member.name,
          sub: `${entry.name} state`,
          ctx: entry.context,
          keywords: keywordsOf(member.name, entry.name),
          // Same rationale as the invariant push above: the owning enum's qualifiedName + element, for
          // Task 5's preview-pane rendering.
          qualifiedName: entry.qualifiedName,
          element,
        });
      }
    }

    // One entry per REAL declared guarded edge (#1163). These come off the OWNER entity/aggregate
    // element that projects `transitions` — enum-`state` entries above come off the ENUM element, so
    // the two never overlap. No edge is ever synthesized from enum-member order (#1145).
    // The owner element flattens every state machine's edges into one `transitions` list, so a bare
    // `<from>-><to>` id is NOT unique — two fields sharing an edge, or two guarded rules on the same
    // edge (`A -> B when g1` / `A -> B when g2`), repeat it. The declaration-order index disambiguates
    // so the launcher's per-entry `id` (a React key + a `lx-opt-…` DOM id) stays unique.
    (element.transitions ?? []).forEach((t, i) => {
      const guard = t.guard ? ` · when ${t.guard}` : '';
      const via = t.via ? ` · via ${t.via}` : '';
      out.push({
        id: `rule:${entry.qualifiedName}:trans:${t.from}->${t.to}:${i}`,
        cat: 'rule',
        rkind: 'transition',
        kind,
        title: `${t.from} → ${t.to}`,
        sub: `${entry.name}${guard}${via}`, // e.g. "Order · when totalIsPositive · via Submit"
        ctx: entry.context,
        keywords: keywordsOf(t.from, t.to, t.guard, t.via, entry.name),
        qualifiedName: entry.qualifiedName,
        element,
        transition: t,
      });
    });
  }
  return out;
}

/** Files ← the caller's already-merged (open buffers + workspace files) + de-duped list. */
function fileEntries(files: { uri: string; relPath: string }[]): CatalogEntry[] {
  return files.map(({ uri, relPath }) => {
    const slash = relPath.lastIndexOf('/');
    const base = slash === -1 ? relPath : relPath.slice(slash + 1);
    const dir = slash === -1 ? '' : relPath.slice(0, slash);
    return {
      id: `file:${uri}`,
      cat: 'file',
      title: base,
      sub: dir,
      ctx: dir,
      keywords: relPath.toLowerCase(),
      file: uri,
      // The un-split path, first-class (#1204): the Source-Control focus key `openFileChanges` reads,
      // decoupled from the `sub`/`title` display split above.
      relPath,
    };
  });
}

/** Glossary ← the ubiquitous-language terms, carrying their doc text for the Task 5 live preview. */
function glossaryEntries(entries: GlossaryEntry[]): CatalogEntry[] {
  return entries.map((entry) => ({
    id: `gloss:${entry.qualifiedName}`,
    cat: 'glossary',
    title: entry.name,
    sub: 'glossary term',
    ctx: entry.context,
    keywords: keywordsOf(entry.name, entry.doc),
    qualifiedName: entry.qualifiedName,
    doc: entry.doc,
  }));
}

/** Commands ← the registry's enablement-filtered list, carrying the command id + hint for Tasks 6/8. */
function commandEntries(commands: Command[]): CatalogEntry[] {
  return commands.map((cmd) => ({
    id: `cmd:${cmd.id}`,
    cat: 'action',
    title: cmd.title,
    sub: cmd.group,
    keywords: keywordsOf(cmd.title, cmd.group),
    cmdId: cmd.id,
    hint: cmd.hint,
  }));
}

/**
 * Commits ← the host's git log, newest first, when `canUseGit`; otherwise NO commit entries at all.
 * The desktop host's `gitLog()` shells out to real `git log` (src-tauri's `git_log`), which rejects
 * whenever the open workspace isn't a git repository — routine for a freshly materialized example or
 * an opened plain folder. That must degrade to "no commits", not sink the whole catalog: this function
 * is raced via `Promise.all` in `buildCatalog` below, so an uncaught rejection here would silently
 * empty out commands/symbols/files/glossary too (#1276).
 */
async function commitEntries(sources: LauncherSources): Promise<CatalogEntry[]> {
  if (!sources.canUseGit) return [];
  const pending = sources.gitLog();
  if (!pending) return [];
  const log = await pending.catch(() => []);
  return log.map(({ sha, author, date, message }) => ({
    id: `commit:${sha}`,
    cat: 'commit',
    title: message,
    sub: `${sha.slice(0, 7)} · ${author}`,
    ctx: author,
    hash: sha,
    keywords: keywordsOf(message, sha),
    // The ISO-8601 author-date, carried through so the live-preview pane (Task 5) can render a commit's
    // "When" row straight from the CatalogEntry, without re-fetching (or re-caching) the raw git log.
    date,
  }));
}

/** Joins every injected source into the launcher's flat result pool, in `GROUPS` display order. */
export async function buildCatalog(sources: LauncherSources): Promise<CatalogEntry[]> {
  const [index, commits] = await Promise.all([sources.modelIndex(), commitEntries(sources)]);
  return [
    ...commandEntries(sources.commands()),
    ...symbolAndEventEntries(index),
    ...ruleEntries(index),
    ...fileEntries(sources.files()),
    ...glossaryEntries(sources.glossary()),
    ...commits,
  ];
}
