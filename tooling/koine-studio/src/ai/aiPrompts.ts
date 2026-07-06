// The Assistant's pure prompt builders (#990): the per-turn system prompt, the explain/repair user
// prompts, and the context types they consume. Extracted verbatim from aiPanel.ts so they unit-test
// without a panel, and so the upcoming Preact chat components share one wording with the imperative
// panel. Everything here is stateless — no DOM, no store, no host services.
import { KOINE_PRIMER } from '@/ai/assistantTools';

/**
 * The compiled domain structure (contexts/aggregates/relations + glossary coverage), so reviews and
 * answers see the real shape of the model, not just the current file. Built best-effort from the LSP.
 */
export interface DomainIndex {
  contexts: string[]; // bounded-context names
  aggregates: { name: string; root: string }[]; // aggregate → its root entity
  relations: { upstream: string; downstream: string; kind: string }[];
  glossaryCoverage: { documented: number; total: number };
}

/** A snapshot of what's on screen, fed to the model as grounding context on every turn. */
export interface AssistantContext {
  fileName: string;
  source: string;
  diagnostics: { line: number; col: number; severity: 'error' | 'warning'; message: string }[];
  /** The compiled domain structure, when the host could build one (absent for scratch/empty models). */
  domainIndex?: DomainIndex;
}

/**
 * A compact, terse summary of the compiled domain structure for the system prompt. Omits any line
 * whose list is empty; renders an aggregate as `name → root` when `root` is non-empty and differs
 * from `name`, else just `name`. Returns '' for a fully-empty index so nothing is injected.
 */
export function formatDomainIndex(idx: DomainIndex): string {
  const lines: string[] = [];
  if (idx.contexts.length) lines.push(`- Contexts: ${idx.contexts.join(', ')}`);
  if (idx.aggregates.length) {
    const aggs = idx.aggregates.map((a) => (a.root && a.root !== a.name ? `${a.name} → ${a.root}` : a.name));
    lines.push(`- Aggregates: ${aggs.join(', ')}`);
  }
  if (idx.relations.length) {
    const rels = idx.relations.map((r) => `${r.upstream} → ${r.downstream} (${r.kind})`);
    lines.push(`- Relations: ${rels.join(', ')}`);
  }
  if (idx.glossaryCoverage.total > 0) {
    lines.push(`- Glossary: ${idx.glossaryCoverage.documented}/${idx.glossaryCoverage.total} documented`);
  }
  if (!lines.length) return '';
  return ['Compiled domain structure:', ...lines].join('\n');
}

/** Build the per-turn system prompt: the primer plus the live model + diagnostics (+ domain index). */
export function buildSystem(ctx: AssistantContext): string {
  const parts = [KOINE_PRIMER, ''];
  parts.push(`Current file: ${ctx.fileName}`);
  parts.push('Current model source:', '```koine', ctx.source.trimEnd(), '```', '');
  if (ctx.diagnostics.length) {
    parts.push('Current diagnostics:');
    for (const d of ctx.diagnostics) {
      parts.push(`- [${d.severity}] line ${d.line}:${d.col} — ${d.message}`);
    }
  } else {
    parts.push('Current diagnostics: none (the model compiles).');
  }
  // Append the compiled domain structure after the diagnostics, separated by a blank line, only when
  // the host built an index that renders to a non-empty summary.
  if (ctx.domainIndex) {
    const domain = formatDomainIndex(ctx.domainIndex);
    if (domain) parts.push('', domain);
  }
  return parts.join('\n');
}

/**
 * Appended to the system prompt only in workspace mode (when the multi-file edit tools are advertised
 * this turn). Without it the primer's "output the COMPLETE model in a single ```koine block" instruction
 * dominates and the model never calls the write tools, so the change-set review silently never appears.
 */
export const WORKSPACE_EDIT_GUIDE = [
  'You are editing a multi-file Koine workspace. When a change spans more than the current file (for',
  'example an integration event touching a publisher context, a subscriber context, and the context',
  'map), do NOT answer with a single ```koine block. Instead use the workspace edit tools: call',
  '`koine_list_files` to see the `.koi` files, `koine_read_file` to read the ones you will change, then',
  '`koine_write_file` once per file to STAGE its complete new contents. Staged edits are shown to the',
  'user as a per-file diff to review and apply — nothing is written to disk until they accept. Only',
  '`.koi` files can be written.',
].join(' ');

/**
 * Build the "Explain this construct" prompt: an EXPLANATORY (never generative) ask aimed at a domain
 * expert who doesn't code. Explains the selected construct when `selectionText` is non-blank, else the
 * whole `fileSource` — the wording adapts so a selection vs whole-model scope reads naturally.
 */
export function buildExplainPrompt(selectionText: string | null, fileSource: string): string {
  const sel = selectionText?.trim() ? selectionText : null;
  const code = sel ?? fileSource;
  const scope = sel
    ? 'Explain this selected Koine construct'
    : 'Explain this Koine model';
  return [
    `${scope} in PLAIN LANGUAGE, for a domain expert who doesn't code. Describe what it`,
    'represents in the domain, the business rules/invariants it enforces, and how the pieces relate —',
    'in terms a non-programmer understands.',
    '',
    'This is explanation only: do NOT output code, and do NOT propose or write a revised model. No',
    'code blocks, no Koine syntax in your answer — prose only.',
    '',
    '```koine',
    code,
    '```',
  ].join('\n');
}

/**
 * Build the parse-and-repair re-prompt (issue #257): hand the model back the `.koi` it just produced
 * plus the `line:column` diagnostics that rejected it, and ask for ONLY the corrected model in a fenced
 * block. Pure (no DOM) so it unit-tests, and so the repair loop and any future caller share one wording.
 */
export function buildRepairPrompt(previous: string, diagnostics: string): string {
  return [
    'The Koine model you produced does not parse. Fix it so it compiles cleanly, and return ONLY the',
    'corrected model in a single ```koine code block — no prose, no explanation.',
    '',
    'Your previous model:',
    '```koine',
    previous,
    '```',
    '',
    'Compiler diagnostics (line:column):',
    diagnostics,
  ].join('\n');
}
