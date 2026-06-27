// The Assistant inspector tab: a small chat UI over the Anthropic Messages API (src/ai.ts). It
// streams replies, keeps the current model + diagnostics in the system prompt so answers stay
// grounded in what's on screen, offers quick actions (explain diagnostics, suggest invariants,
// review, generate), and lets the user apply a generated `.koi` model straight into the editor.
//
// Needs a user-supplied Anthropic API key (set in Preferences, stored locally). With no key it
// shows a prompt to add one rather than calling the API.
import { isLocalProviderUrl, runAssistant, type AiProvider, type ChatMessage } from '@/ai/ai';
import {
  chooseMechanism,
  isGrammarCapable,
  parseValidationOutcome,
  probeGrammarCapability,
  repairBudgetFor,
  repairToValid,
  type ConstraintMechanism,
} from '@/ai/grammarConstraint';
import { KOINE_PRIMER } from '@/ai/assistantTools';
import { createEditSession, type EditSession, type StagedEdit } from '@/ai/editSession';
import { renderMarkdown } from '@/editor/editor';
import { loadChat, saveChat, clearChat } from '@/settings/persistence';

/**
 * Most parse-and-repair rounds the assistant will attempt before declaring it could not produce a
 * model that parses (issue #257). Each round is a full extra LLM turn (latency + tokens), so this is
 * a small constant rather than the larger {@link import('@/ai/ai').MAX_TOOL_ROUNDS} agentic-loop cap.
 */
export const MAX_REPAIR_ROUNDS: number = 3;

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

export interface AssistantPanelOptions {
  container: HTMLElement;
  /** The configured provider ('anthropic' | 'openai'). */
  getProvider: () => AiProvider;
  /** The OpenAI-compatible base URL (used only when the provider is 'openai'). */
  getBaseUrl: () => string;
  /** The API key (empty string when unset; not required for local servers). */
  getApiKey: () => string;
  /** The model id to use (provider-appropriate defaults handled in ai.ts). */
  getModel: () => string;
  /** The current editor model + diagnostics, captured fresh on each send (may be async). */
  getContext: () => AssistantContext | Promise<AssistantContext>;
  /** The current editor selection (the construct to explain), or null when there's nothing useful. */
  getSelection: () => { text: string } | null;
  /** Replace the active editor document with a generated model. */
  onApplyModel: (source: string) => void;
  /** Open Preferences (so the user can add their API key). */
  onOpenPrefs: () => void;
  /**
   * The per-workspace storage key for the conversation (the folder identity, or the literal
   * 'scratch' in scratch mode), so each opened folder keeps its own transcript across reloads.
   */
  getWorkspaceKey: () => string;
  /**
   * Execute a Koine compiler tool (validate/compile/format) by name with JSON args, for the
   * assistant's tool loop (OpenAI-compatible path). Omitted when the host can't run tools, in which
   * case the assistant stays plain chat.
   */
  runCompilerTool?: (name: string, argsJson: string) => Promise<string>;
  /**
   * Whether to advertise the compiler tools to the model. Off keeps replies streaming — local
   * servers (LM Studio / Ollama) buffer the whole completion when tools are present. When false we
   * withhold `runCompilerTool` so ai.ts runs a plain single-round streaming chat.
   */
  getUseTools: () => boolean;
  /**
   * Whether to constrain/guarantee the assistant's generated `.koi` parses (issue #257, on by default).
   * When on: a grammar-capable local backend has its decoding constrained by the GBNF; every other
   * provider validates-and-repairs the candidate, and "Apply to editor" stays disabled until it parses.
   */
  getConstrainGrammar: () => boolean;
  /**
   * Fetch the llama.cpp GBNF grammar from the host, to constrain a grammar-capable local model's
   * decoding (issue #257). Browser-host ONLY — the desktop host omits it, in which case the panel
   * falls back to the parse-and-repair path. Fetched defensively (a throw is treated as "unavailable").
   */
  getGrammar?: () => Promise<string>;
  /**
   * Snapshot the open workspace's .koi files as relPath→current-text, captured fresh per send. When
   * present & non-empty together with {@link runEditTool}, the assistant can edit ACROSS files.
   */
  getWorkspaceFiles?: () => Record<string, string>;
  /** Host executor for the list/read/write edit tools against the per-turn staging session. */
  runEditTool?: (name: string, argsJson: string, session: EditSession) => Promise<string>;
  /**
   * Validate the WHOLE staged workspace once, at end of an agentic turn (host-supplied: browser WASM
   * `DiagnoseWorkspace`, desktop MCP `koine_validate`). Wired into the request so `runToolLoop` runs it
   * a SINGLE time after the turn instead of after each `koine_write_file` (issue #474); the resulting
   * diagnostics are shown in the change-set panel for pre-apply review.
   */
  validateStaged?: (session: EditSession) => Promise<string>;
  /**
   * Commit an accepted multi-file change set: write each accepted file through the workspace
   * controller (new files under the folder root), then re-validate. Resolves with the relPaths whose
   * write FAILED (empty when all succeeded) so the panel can report a partial apply instead of a
   * false "Applied ✓".
   */
  onApplyChangeSet?: (files: StagedEdit[]) => Promise<{ failed: string[] }>;
}

export interface AssistantPanel {
  /** Move keyboard focus into the prompt input. */
  focusInput(): void;
  /**
   * Re-point the panel at the current workspace's conversation when the folder changed: reload the
   * transcript from storage and rebuild the bubbles. A no-op when the workspace key is unchanged, so
   * the host can call it on every tab show without recreating the panel.
   */
  syncWorkspace(): void;
  /**
   * Explain the current construct (the editor selection, or the whole model when there's none) in
   * plain language — an explanatory turn that does NOT offer to apply anything. For the command palette.
   */
  explainSelection(): void;
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
const WORKSPACE_EDIT_GUIDE = [
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

/**
 * The model source from a markdown reply: prefer a ```koine / ```koi fenced block (tolerating an
 * info string and trailing whitespace on the opening fence — e.g. ```koine billing.koi), and fall
 * back to the first fenced block of any language. Returns null when there is no fenced block.
 */
function extractKoine(markdown: string): string | null {
  const koine = markdown.match(/```[ \t]*(?:koine|koi)\b[^\n]*\n([\s\S]*?)```/);
  if (koine) return koine[1].replace(/\n+$/, '');
  const any = markdown.match(/```[^\n]*\n([\s\S]*?)```/);
  return any ? any[1].replace(/\n+$/, '') : null;
}

/**
 * A minimal line-level diff for the change-set preview: an LCS walk marks lines only in the new body
 * with `+`, lines only in the old with `-`, and shared lines with a leading space. Presentation only
 * (the test asserts the badges/toggles/apply, not the diff content), so a compact LCS is plenty.
 */
function lineDiff(oldText: string, newText: string): string {
  const a = oldText.length ? oldText.split('\n') : [];
  const b = newText.length ? newText.split('\n') : [];
  const m = a.length;
  const n = b.length;
  // lcs[i][j] = length of the longest common subsequence of a[i..] and b[j..].
  const lcs: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push(`  ${a[i]}`);
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push(`- ${a[i]}`);
      i++;
    } else {
      out.push(`+ ${b[j]}`);
      j++;
    }
  }
  while (i < m) out.push(`- ${a[i++]}`);
  while (j < n) out.push(`+ ${b[j++]}`);
  return out.join('\n');
}

/**
 * A handle to a rendered agentic change set, so the panel can retire it when it goes stale (issue #473):
 * a new turn supersedes a prior un-applied proposal whose `before` was computed against an older
 * workspace snapshot.
 */
interface ChangeSetHandle {
  /**
   * Disable Apply + every accept checkbox and announce `reason` in the status live region, so an
   * obsolete panel can no longer be applied. A no-op once the set has already been applied (must not
   * overwrite the terminal "Applied ✓").
   */
  invalidate(reason: string): void;
}

/**
 * Render a reviewable, per-file change set for an AGENTIC turn that STAGED multi-file edits: one row
 * per staged file (an accept checkbox, a new/modified badge, the relPath, and an inline line-diff of
 * the file's before-text vs the staged body), plus an "Apply N files" button (whose label/disabled
 * track the accepted count) and a "Discard" button. Apply commits only the still-accepted files via
 * `handlers.onApply`, then becomes a terminal "Applied ✓" and drops Discard; Discard removes the panel.
 *
 * `diagnostics` is the once-per-turn whole-staged-workspace validation summary (issue #474): when it
 * reports errors (`ok: false …`), they're shown alongside the file rows so a write that broke the model
 * is visible BEFORE the user applies; a clean (`ok: true …`) or absent result renders no extra noise.
 *
 * Returns a {@link ChangeSetHandle} the caller keeps as the panel's active change set, so a later turn
 * can supersede this one (issue #473).
 */
function renderChangeSet(
  bubble: HTMLElement,
  staged: StagedEdit[],
  before: Record<string, string>,
  handlers: {
    onApply: (accepted: StagedEdit[]) => Promise<{ failed: string[] }>;
    onDiscard: () => void;
    /**
     * A LIVE read of the workspace text for `relPath`, taken at APPLY time (issue #473). Compared to
     * the send-time `before` to detect drift — a file the user edited while the turn ran — so a stale
     * staged body can't silently clobber newer work. `undefined` ⇒ the file isn't currently readable.
     */
    currentText: (relPath: string) => string | undefined;
  },
  diagnostics?: string | null,
): ChangeSetHandle {
  const panel = document.createElement('div');
  panel.className = 'koi-changeset';
  // A labelled group so assistive tech announces the scope of the review (WCAG 2.1 AA 1.3.1 / 4.1.2).
  panel.setAttribute('role', 'group');
  panel.setAttribute('aria-label', `${staged.length} proposed file change${staged.length === 1 ? '' : 's'}`);

  // The set of still-accepted edits (all on by default); the Apply label + the committed list read from it.
  const accepted = new Set<StagedEdit>(staged);
  // The accept checkboxes, so a successful apply can disable them all (a toggle afterwards must not
  // re-enable Apply and let the same change set be written to disk a second time).
  const checkboxes: HTMLInputElement[] = [];
  // Each staged file's row, so a drift warning can be attached to the right one at apply time (#473).
  const rowByFile = new Map<StagedEdit, HTMLElement>();
  // Whether this set has been fully applied — once true, invalidation is a no-op so a later turn can't
  // overwrite the terminal "Applied ✓" with a "superseded" notice (issue #473).
  let applied = false;
  // Whether this set has been superseded by a later turn (#473/#684) — once true, an apply that was
  // already in flight when the panel was retired and settles AFTERWARDS is a no-op: it must not call
  // refreshApply() (re-enabling Apply on a retired panel) nor overwrite the "superseded" notice. The
  // reverse of the `applied` guard above, keeping "superseded" a terminal state.
  let invalidated = false;

  const applyBtn = document.createElement('button');
  applyBtn.type = 'button';
  applyBtn.className = 'koi-changeset-apply';

  const discardBtn = document.createElement('button');
  discardBtn.type = 'button';
  discardBtn.className = 'koi-changeset-discard';
  discardBtn.textContent = 'Discard';

  // A polite live region so a screen reader announces the apply outcome (WCAG 2.1 AA 4.1.3).
  const status = document.createElement('div');
  status.className = 'koi-changeset-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');

  function refreshApply(): void {
    const n = accepted.size;
    applyBtn.textContent = `Apply ${n} file${n === 1 ? '' : 's'}`;
    applyBtn.disabled = n === 0;
  }

  for (const file of staged) {
    const row = document.createElement('div');
    row.className = 'koi-changeset-file';

    const check = document.createElement('input');
    check.type = 'checkbox';
    check.className = 'koi-changeset-accept';
    check.checked = true;
    check.setAttribute('aria-label', `Accept changes to ${file.relPath}`);
    check.addEventListener('change', () => {
      if (check.checked) accepted.add(file);
      else accepted.delete(file);
      refreshApply();
    });
    checkboxes.push(check);
    row.appendChild(check);

    const badge = document.createElement('span');
    badge.className = `koi-changeset-badge ${file.isNew ? 'koi-changeset-badge-new' : 'koi-changeset-badge-modified'}`;
    badge.textContent = file.isNew ? 'new' : 'modified';
    row.appendChild(badge);

    const path = document.createElement('span');
    path.className = 'koi-changeset-path';
    path.textContent = file.relPath;
    row.appendChild(path);

    const diff = document.createElement('pre');
    diff.className = 'koi-changeset-diff';
    diff.textContent = lineDiff(before[file.relPath] ?? '', file.body);
    row.appendChild(diff);

    rowByFile.set(file, row);
    panel.appendChild(row);
  }

  // Drift check (#473): has `file`'s LIVE text moved away from the send-time `before` it was staged
  // against? A drifted file must be skipped so a stale full-file body can't clobber newer work.
  function isDrifted(file: StagedEdit): boolean {
    const cur = handlers.currentText(file.relPath);
    const base = before[file.relPath];
    if (cur === undefined) {
      // The file isn't currently readable (closed/removed): safe only if there was nothing to overwrite
      // (base empty or absent); otherwise we can't confirm the target is still the reviewed text → warn.
      return !(base === undefined || base === '');
    }
    // A brand-new file whose path now EXISTS (cur defined): don't clobber a file created since SEND.
    if (file.isNew) return true;
    // An existing modification: drift iff the live text differs from the reviewed `before`.
    return cur !== (base ?? '');
  }

  // Attach a persistent "changed since proposed" warning to a drifted file's row (idempotent).
  function markDrift(file: StagedEdit): void {
    const row = rowByFile.get(file);
    if (!row || row.querySelector('.koi-changeset-drift')) return;
    const warn = document.createElement('span');
    warn.className = 'koi-changeset-drift';
    warn.textContent = 'Changed since this was proposed — skipped to protect your edits.';
    row.appendChild(warn);
  }

  applyBtn.addEventListener('click', () => {
    const list = staged.filter((f) => accepted.has(f));
    if (!list.length) return;

    // Partition the accepted files against a LIVE read taken NOW (#473): a file the user edited while
    // the turn ran (drift) is warned + skipped; only the clean subset is written. The send-time `before`
    // still backs the REVIEWED diff above — drift is judged against the current text at apply time.
    const drifted = list.filter(isDrifted);
    const clean = list.filter((f) => !drifted.includes(f));
    for (const f of drifted) markDrift(f);

    if (!clean.length) {
      // Everything selected drifted: write nothing, keep the panel open with the warnings, and leave
      // Apply usable for a fresh review (don't strand it in the in-flight disabled state).
      status.textContent =
        `${drifted.length} file${drifted.length === 1 ? '' : 's'} changed since ` +
        `${drifted.length === 1 ? 'it was' : 'they were'} proposed; nothing was applied. ` +
        `Send again for a fresh proposal.`;
      refreshApply();
      return;
    }

    const skipped = drifted.length
      ? ` Skipped ${drifted.length} that changed since ${drifted.length === 1 ? 'it was' : 'they were'} proposed.`
      : '';
    // Announce the skip synchronously (drift detection is synchronous) so the warning is visible the
    // instant Apply is clicked; the async result below refines it to the final "Applied N" message.
    if (drifted.length) status.textContent = `Applying ${clean.length} clean file${clean.length === 1 ? '' : 's'}.${skipped}`;

    applyBtn.disabled = true; // guard the in-flight window
    void Promise.resolve(handlers.onApply(clean)).then((result) => {
      // A panel superseded WHILE this apply was in flight is terminal (#684): a late settle must not
      // un-retire it. Covers both the { failed } and the success branch below — no status overwrite,
      // no refreshApply() re-enabling Apply on a panel the user can no longer act on.
      if (invalidated) return;
      if (result.failed.length) {
        // Partial/total failure: report exactly which files didn't write and re-open Apply so the user
        // can retry the still-checked set, rather than a false "Applied ✓".
        const wrote = clean.length - result.failed.length;
        status.textContent =
          `${wrote ? `Applied ${wrote} file${wrote === 1 ? '' : 's'}; ` : ''}` +
          `couldn't write ${result.failed.length}: ${result.failed.join(', ')}. Re-apply to retry.` +
          skipped;
        refreshApply();
        return;
      }
      // Success: lock the review (disable the checkboxes so a later toggle can't trigger a second write)
      // and mark Apply terminal.
      applied = true;
      for (const cb of checkboxes) cb.disabled = true;
      applyBtn.textContent = `Applied ${clean.length} file${clean.length === 1 ? '' : 's'} ✓`;
      status.textContent = `Applied ${clean.length} file${clean.length === 1 ? '' : 's'}.` + skipped;
      discardBtn.remove();
    }).catch((e) => {
      // A panel superseded mid-apply stays terminal (#684): a late rejection must not re-enable Apply
      // or replace the "superseded" notice with an "Apply failed" one that invites a retry on a retired
      // change set.
      if (invalidated) return;
      // onApply REJECTED (#633): applyFileEdit only turns disk-write errors into a { failed } result;
      // an un-guarded throw from a non-disk op (renderer/LSP sync, dirty refresh, saved-callback) escapes
      // as a rejection. Without this catch the Apply button stays stuck disabled, the error is swallowed,
      // and the rejection is unhandled. Re-open Apply (re-enabling retry of the still-checked set) and
      // surface the error in the polite live region so the failure is announced and recoverable.
      status.textContent = `Apply failed: ${String(e)}` + skipped;
      refreshApply();
    });
  });
  discardBtn.addEventListener('click', () => {
    handlers.onDiscard();
    panel.remove();
  });

  // End-of-turn whole-staged-workspace validation diagnostics (issue #474): surface them whenever the
  // single end-of-turn validation reported anything other than a CLEAN compile (`ok: true …`) — that
  // covers errors, warnings, and a "could not validate" note (e.g. the desktop MCP sidecar briefly
  // unreachable) — so a write that broke the model, or a validation that didn't actually run, is
  // reviewable/discardable BEFORE apply. A clean compile (or no validation at all) shows nothing.
  if (diagnostics && !diagnostics.startsWith('ok: true')) {
    const diag = document.createElement('pre');
    diag.className = 'koi-changeset-diagnostics';
    diag.textContent = diagnostics;
    diag.setAttribute('aria-label', 'Validation diagnostics for the staged changes');
    panel.appendChild(diag);
  }

  refreshApply();
  panel.append(applyBtn, discardBtn, status);
  bubble.appendChild(panel);

  return {
    invalidate(reason: string): void {
      // Once applied, the panel is terminal ("Applied ✓") — never overwrite that with a stale notice.
      if (applied) return;
      // Mark the panel terminal so an apply already in flight that settles AFTER this supersede can't
      // un-retire it (#684 — the reverse of the `applied` guard above).
      invalidated = true;
      panel.classList.add('koi-changeset-superseded');
      applyBtn.disabled = true;
      for (const cb of checkboxes) cb.disabled = true;
      // Announce in the polite live region so assistive tech learns the proposal can no longer be
      // applied (WCAG 2.1 AA 4.1.3); the message carries the `reason` (e.g. "superseded").
      status.textContent = `This change set was ${reason} by a newer turn and can no longer be applied.`;
    },
  };
}

export function createAssistantPanel(opts: AssistantPanelOptions): AssistantPanel {
  // The transcript for the workspace this panel is currently pointed at. Restored from storage on
  // mount and re-pointed by syncWorkspace() when the folder changes; loadedKey tracks which one.
  let messages: ChatMessage[] = loadChat(opts.getWorkspaceKey());
  let loadedKey = opts.getWorkspaceKey();
  let aborter: AbortController | null = null;
  // The most recently rendered, still-un-applied agentic change set (issue #473). A new send supersedes
  // it (its `before` was computed against an older workspace snapshot); cleared once it applies/discards.
  let activeChangeSet: ChangeSetHandle | null = null;

  opts.container.classList.add('koi-assistant');
  opts.container.innerHTML = '';

  const transcript = document.createElement('div');
  transcript.className = 'koi-assistant-transcript';
  opts.container.appendChild(transcript);

  // Empty-state hint shown until the first message.
  const intro = document.createElement('div');
  intro.className = 'koi-assistant-intro';
  intro.innerHTML =
    '<p><strong>Domain copilot.</strong> Describe a domain to model, or ask about the current one. ' +
    'Use the quick actions below, or type a prompt.</p>';
  transcript.appendChild(intro);

  // --- controls (quick actions + input) -------------------------------------
  const controls = document.createElement('div');
  controls.className = 'koi-assistant-controls';
  opts.container.appendChild(controls);

  const quick = document.createElement('div');
  quick.className = 'koi-assistant-quick';
  controls.appendChild(quick);

  const QUICK_ACTIONS: { label: string; build: (ctx: AssistantContext) => string }[] = [
    {
      label: 'Explain diagnostics',
      build: (ctx) =>
        ctx.diagnostics.length
          ? 'Explain each current diagnostic in plain language and show how to fix it.'
          : 'The model currently compiles with no diagnostics. Point out any latent modeling risks anyway.',
    },
    { label: 'Suggest invariants', build: () => 'Suggest domain invariants this model is probably missing, with the Koine syntax to add each.' },
    { label: 'Review model', build: () => 'Review this model for DDD smells (anemic types, leaked identity, missing aggregates, wrong boundaries) and suggest concrete fixes.' },
    { label: 'Add an aggregate', build: () => 'Propose one additional aggregate that would round out this domain, and give the full updated model.' },
  ];

  const input = document.createElement('textarea');
  input.className = 'koi-assistant-input';
  input.rows = 3;
  input.placeholder = 'Describe a domain to model, or ask about this one…  (⌘/Ctrl+Enter to send)';
  input.setAttribute('aria-label', 'Assistant prompt');

  const row = document.createElement('div');
  row.className = 'koi-assistant-inputrow';

  const sendBtn = document.createElement('button');
  sendBtn.type = 'button';
  sendBtn.className = 'koi-assistant-send';
  sendBtn.textContent = 'Send';

  const stopBtn = document.createElement('button');
  stopBtn.type = 'button';
  stopBtn.className = 'koi-assistant-stop';
  stopBtn.textContent = 'Stop';
  stopBtn.hidden = true;

  row.append(input, sendBtn, stopBtn);
  controls.append(quick, row);

  for (const action of QUICK_ACTIONS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'koi-assistant-action';
    b.textContent = action.label;
    b.addEventListener('click', () => {
      if (busy()) return;
      // Await getContext once and reuse it for both the action prompt and the system prompt.
      void (async () => {
        const ctx = await opts.getContext();
        await send(action.build(ctx), ctx);
      })();
    });
    quick.appendChild(b);
  }

  // "Explain this construct": an EXPLANATORY turn for a non-coding domain expert — explains the
  // selection (or whole model) in plain language, with the Apply affordance suppressed (offerApply
  // false) since the reply is prose, not a model to apply. Reuses the resolved context for both prompts.
  async function runExplain(): Promise<void> {
    if (busy()) return;
    const sel = opts.getSelection();
    const ctx = await opts.getContext();
    await send(buildExplainPrompt(sel?.text ?? null, ctx.source), ctx, { offerApply: false });
  }

  const explainBtn = document.createElement('button');
  explainBtn.type = 'button';
  explainBtn.className = 'koi-assistant-action';
  explainBtn.textContent = 'Explain this construct';
  explainBtn.addEventListener('click', () => {
    if (busy()) return;
    void runExplain();
  });
  quick.appendChild(explainBtn);

  // Forget this workspace's conversation: empty the in-memory history, reset the transcript to the
  // empty state, and drop the stored blob. Refused while a request is in flight so it can't race the
  // streaming reply (which would re-persist the half-finished turn after the clear).
  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = 'koi-assistant-clear';
  clearBtn.textContent = 'Clear conversation';
  clearBtn.addEventListener('click', () => {
    if (busy()) return;
    messages = [];
    rebuildTranscript();
    clearChat(opts.getWorkspaceKey());
  });
  quick.appendChild(clearBtn);

  function busy(): boolean {
    return aborter !== null;
  }

  function setBusy(on: boolean): void {
    sendBtn.disabled = on;
    stopBtn.hidden = !on;
    input.disabled = on;
    for (const b of Array.from(quick.querySelectorAll('button'))) (b as HTMLButtonElement).disabled = on;
  }

  function addBubble(role: 'user' | 'assistant'): HTMLDivElement {
    if (intro.parentNode) intro.remove();
    const bubble = document.createElement('div');
    bubble.className = `koi-msg koi-msg-${role}`;
    transcript.appendChild(bubble);
    transcript.scrollTop = transcript.scrollHeight;
    return bubble;
  }

  // Attach an enabled "Apply to editor" button that applies the GIVEN source (which, on the repair
  // path, is the validated/repaired candidate — not necessarily the text in the rendered markdown).
  function attachApplyButton(bubble: HTMLElement, source: string): void {
    const apply = document.createElement('button');
    apply.type = 'button';
    apply.className = 'koi-assistant-apply';
    apply.textContent = 'Apply to editor';
    apply.addEventListener('click', () => {
      opts.onApplyModel(source);
      apply.textContent = 'Applied ✓';
      apply.disabled = true;
    });
    bubble.appendChild(apply);
  }

  // Append an "Apply to editor" affordance when the assistant produced a model — re-validating the
  // candidate first so the two LEGACY entry points (transcript replay, stop-mid-stream) can't apply a
  // model that never passed the live apply-gate (#444). Both reach here without the live path's
  // validation, so we re-run the SAME adapter via {@link shouldOfferApply} before offering.
  //
  // Candidate recovery mirrors the live path (#561): a genuinely grammar-constrained reply is a BARE
  // `.koi` program with NO ```koine fence (the GBNF root can't emit one), so `extractKoine` returns
  // null for it. When there's no fence AND the constraint toggle is on, fall back to the trimmed body
  // as the candidate — only on the constrained path, since the bare-program shape only arises there, so
  // this preserves the legacy "off ⇒ fenced-only" behavior. The candidate still clears `shouldOfferApply`
  // either way, so a valid bare model is offered Apply, prose that doesn't parse is rejected, and the
  // #444 bypass stays closed (no Apply without validation).
  async function maybeOfferApply(bubble: HTMLElement, markdown: string): Promise<void> {
    const candidate =
      extractKoine(markdown) ?? (opts.getConstrainGrammar() ? markdown.trim() || null : null);
    if (candidate && (await shouldOfferApply(candidate))) attachApplyButton(bubble, candidate);
  }

  // Should a model-bearing LEGACY turn (transcript replay / stop-mid-stream partial) offer Apply?
  // With the constraint toggle OFF the apply-gate claims nothing, so behave as the legacy path always
  // did — offer Apply for any extracted model. With it ON, run the live path's validate adapter and
  // offer Apply only when the model parses; fail CLOSED (no Apply) when the adapter is unavailable or
  // throws, since we then can't prove the model is valid (#444).
  async function shouldOfferApply(koine: string): Promise<boolean> {
    if (!opts.getConstrainGrammar()) return true;
    const validate = makeValidate();
    if (!validate) return false;
    try {
      return (await validate(koine)).ok;
    } catch {
      return false;
    }
  }

  // A small status chip on an assistant turn ("grammar-constrained" / "parse-and-repair"). Returns the
  // element so the caller can relabel it if the mechanism degrades mid-turn (gbnf → repair, #446).
  function addChip(bubble: HTMLElement, label: string): HTMLElement {
    const chip = document.createElement('span');
    chip.className = 'koi-assistant-chip';
    // Status indicator, not decoration: expose the mechanism to assistive tech (WCAG 2.1 AA 4.1.3).
    chip.setAttribute('role', 'status');
    chip.textContent = label;
    bubble.appendChild(chip);
    return chip;
  }

  // The validate seam for the apply-gate: adapt the host's `koine_validate` tool (in-WASM in the
  // browser, the MCP sidecar on desktop) into a {ok, diagnostics}. Null when the host can't run tools,
  // in which case the gate is skipped (we can't parse, so we fall back to the unguarded affordance).
  function makeValidate(): ((source: string) => Promise<{ ok: boolean; diagnostics: string }>) | null {
    const run = opts.runCompilerTool;
    if (!run) return null;
    return async (source) => parseValidationOutcome(await run('koine_validate', JSON.stringify({ source })));
  }

  /**
   * Render a finished, CONSTRAINED assistant reply (issue #257): the markdown body, then — for a
   * generative turn that produced a `.koi` candidate — a mechanism chip and a gated "Apply" button.
   *
   *  • `off`    → exactly the legacy behavior: offer Apply unconditionally.
   *  • `gbnf`   → the output is meant to be valid by construction; we validate, and the "grammar-constrained"
   *               chip stays only while that holds. If the backend silently ignored the grammar so the
   *               candidate fails to parse, the path SELF-HEALS into the same bounded repair loop as
   *               `repair` (issue #446) — relabelling the chip to "parse-and-repair" — so it's never
   *               strictly worse than parse-and-repair.
   *  • `repair` → bounded parse-and-repair against the real Koine parser, a live "repair k/N" counter
   *               and a "parse-and-repair" chip; Apply is enabled only when a candidate finally parses,
   *               else a "couldn't produce valid Koine" notice is shown and Apply stays disabled.
   *
   * Never throws — a failed/aborted repair turn is folded into an `ok:false` outcome — so it can be
   * awaited inside `send`'s try without disturbing its abort/error handling.
   */
  async function renderConstrainedReply(
    bubble: HTMLElement,
    content: string,
    offerApply: boolean,
    mechanism: ConstraintMechanism,
    ctx: AssistantContext,
  ): Promise<void> {
    bubble.innerHTML = `<div class="koi-md">${renderMarkdown(content)}</div>`;
    if (!offerApply) return; // explanatory turn — no model to apply, no chip, no gate

    // On the grammar-constrained path the GBNF root is a BARE `.koi` program — the grammar can't emit a
    // ```` ```koine ```` fence — so a genuinely constrained reply is the model itself with no fence.
    // Fall back to the whole body there; the other paths still require a fenced block (prose ⇒ nothing).
    const candidate =
      extractKoine(content) ?? (mechanism === 'gbnf' ? content.trim() || null : null);
    if (!candidate) return; // prose reply — nothing to apply or gate

    const validate = makeValidate();
    // Legacy / no-gate path: the toggle is off, or the host can't validate, so behave as before.
    if (mechanism === 'off' || !validate) {
      attachApplyButton(bubble, candidate);
      return;
    }

    const chip = addChip(bubble, mechanism === 'gbnf' ? 'grammar-constrained' : 'parse-and-repair');

    // Both 'gbnf' and 'repair' now self-heal (issue #446): validate once and, on failure, fall into the
    // SAME bounded repair loop — so the gbnf path is never strictly worse than parse-and-repair. A
    // grammar that was honored makes the first candidate valid (rounds:0 → no repair, chip unchanged); a
    // grammar the backend silently ignored (Ollama) fails that validate and degrades into the repair
    // loop. The round budget lives in `repairBudgetFor` so the policy is in one place.
    const maxRounds = repairBudgetFor(mechanism, MAX_REPAIR_ROUNDS);
    // A live "repair k/N" counter, ticked only when a repair round actually runs (so it stays empty on
    // the gbnf happy path and a first-try-valid repair). A live region announces each tick (WCAG 4.1.3).
    const counter = document.createElement('div');
    counter.className = 'koi-assistant-repair-counter';
    counter.setAttribute('role', 'status');
    counter.setAttribute('aria-live', 'polite');
    bubble.appendChild(counter);

    let round = 0;
    let result: { source: string; ok: boolean; rounds: number };
    try {
      result = await repairToValid(
        candidate,
        {
          validate,
          regenerate: async (previous, diagnostics) => {
            round++;
            counter.textContent = `repair ${round}/${maxRounds}`;
            const repaired = await runAssistant({
              provider: opts.getProvider(),
              baseUrl: opts.getBaseUrl(),
              apiKey: opts.getApiKey(),
              model: opts.getModel(),
              system: buildSystem(ctx),
              messages: [...messages, { role: 'user', content: buildRepairPrompt(previous, diagnostics) }],
              signal: aborter?.signal,
              // Stream nothing into the bubble — we only want the corrected candidate, not a second body.
              onText: () => {},
            });
            return extractKoine(repaired) ?? repaired;
          },
        },
        maxRounds,
      );
    } catch {
      // A network error / user-abort during a repair turn: treat it as "could not validate".
      result = { source: candidate, ok: false, rounds: round };
    }

    // A gbnf turn that had to repair means the grammar wasn't actually honored — relabel the chip so it
    // stops claiming a constraint that didn't hold (Task 2's probe makes this case rare to begin with).
    if (mechanism === 'gbnf' && result.rounds > 0) chip.textContent = 'parse-and-repair';

    if (result.ok) {
      attachApplyButton(bubble, result.source);
    } else {
      const notice = document.createElement('div');
      notice.className = 'koi-assistant-invalid';
      // The failure + disabled-Apply state is conveyed only by this text, so announce it (WCAG 2.1 AA 4.1.3).
      notice.setAttribute('role', 'alert');
      // Both paths spend repair rounds now, so the message reflects the attempts that were made.
      notice.textContent = `Couldn't produce valid Koine after ${maxRounds} repair attempt${maxRounds === 1 ? '' : 's'} — Apply is disabled.`;
      bubble.appendChild(notice);
    }
  }

  // Render a finished assistant reply into a bubble: the markdown body, plus the "Apply to editor"
  // affordance unless this turn opted out (an explanatory turn whose reply must not be applied).
  // Used by transcript replay. Apply is now gated on re-validation (#444): the bubble paints
  // immediately and the button attaches asynchronously once the model is confirmed to parse (never
  // if it doesn't) — fire-and-forget, so replay stays synchronous and bubble order is preserved.
  function renderAssistantReply(bubble: HTMLElement, content: string, offerApply: boolean): void {
    bubble.innerHTML = `<div class="koi-md">${renderMarkdown(content)}</div>`;
    if (offerApply) void maybeOfferApply(bubble, content);
  }

  // Render one stored turn into a bubble: user text verbatim, assistant markdown with the apply
  // affordance honoring the turn's persisted opt-out (so a replayed Explain reply stays apply-free).
  // Shared by mount and syncWorkspace replay.
  function replayMessage(m: ChatMessage): void {
    const bubble = addBubble(m.role);
    if (m.role === 'assistant') {
      renderAssistantReply(bubble, m.content, m.offerApply !== false);
    } else {
      bubble.textContent = m.content;
    }
  }

  // Clear the transcript DOM back to the empty state (intro only), then replay the in-memory history.
  // Used on mount and whenever syncWorkspace swaps to another workspace's conversation.
  function rebuildTranscript(): void {
    transcript.innerHTML = '';
    transcript.appendChild(intro);
    for (const m of messages) replayMessage(m);
  }

  // Restore the current workspace's conversation on first paint.
  rebuildTranscript();

  async function send(
    text: string,
    ctxOverride?: AssistantContext,
    sendOpts?: { offerApply?: boolean },
  ): Promise<void> {
    const offerApply = sendOpts?.offerApply ?? true;
    const prompt = text.trim();
    if (!prompt || busy()) return;

    const provider = opts.getProvider();
    const baseUrl = opts.getBaseUrl();
    const apiKey = opts.getApiKey();
    // Whether a *usable* key was configured for this turn: a whitespace-only stored value is truthy
    // but unusable, so trim before deciding. Captured once so both the pre-flight guard and the
    // catch-block auth-error copy agree on whether a key was actually present (#530).
    const hasKey = !!apiKey.trim();
    // A key is required for Anthropic and for any remote OpenAI-compatible endpoint; local servers
    // (Ollama / LM Studio on localhost) need no auth, so a blank key is fine there.
    const needsKey = provider === 'anthropic' || !isLocalProviderUrl(baseUrl);
    if (needsKey && !hasKey) {
      const note = addBubble('assistant');
      note.classList.add('koi-msg-note');
      note.innerHTML = 'Add your API key in Settings to use the assistant. ';
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'koi-link-btn';
      open.textContent = 'Open Settings';
      open.addEventListener('click', () => opts.onOpenPrefs());
      note.appendChild(open);
      return;
    }

    // #473: a new turn supersedes any still-un-applied change set from a prior turn — its staged bodies
    // were computed against an older workspace snapshot, so retire it (disable Apply + accept checkboxes,
    // announce "superseded") rather than let a late click clobber everything done since.
    activeChangeSet?.invalidate('superseded');
    activeChangeSet = null;

    input.value = '';
    const userBubble = addBubble('user');
    userBubble.textContent = prompt;
    messages.push({ role: 'user', content: prompt });

    const replyBubble = addBubble('assistant');
    replyBubble.textContent = '…';

    // A muted one-line note per tool call the model makes, inserted above the final reply so the user
    // can see the assistant ran a koine tool (and its outcome) rather than answering blind. Tracked so
    // a full turn rollback can remove them too (no orphaned tool lines above a removed user bubble).
    const toolNodes: HTMLElement[] = [];
    const addToolStatus = (name: string, summary: string): void => {
      // Any text streamed this round was a "thinking" preamble before the tool call — clear it so the
      // tool line and the eventual answer render in chronological order (ai.ts keeps it out of history).
      full = '';
      replyBubble.textContent = '…';
      const node = document.createElement('div');
      node.className = 'koi-assistant-tool';
      node.textContent = summary ? `${name} → ${summary}` : `ran ${name}`;
      transcript.insertBefore(node, replyBubble);
      toolNodes.push(node);
      transcript.scrollTop = transcript.scrollHeight;
    };

    // Acquire the busy lock synchronously — BEFORE the first await — so a second rapid send (Enter
    // twice, or Enter then a quick action) can't slip past the busy() guard while getContext, now
    // async, is in flight. Capture the workspace key now too, so a folder switch mid-stream can't
    // persist this turn under the wrong workspace.
    aborter = new AbortController();
    setBusy(true);
    const workspaceKey = opts.getWorkspaceKey();
    // Commit a finished assistant turn to history + storage under the captured key, carrying the apply
    // opt-out so a replay of an explanatory turn stays apply-free.
    const commitAssistantTurn = (content: string): void => {
      const turn: ChatMessage = { role: 'assistant', content };
      if (!offerApply) turn.offerApply = false;
      messages.push(turn);
      saveChat(workspaceKey, messages);
    };
    let full = '';
    try {
      // Fetch the grounding context ONCE (a quick-action caller passes the one it already resolved, so
      // getContext — which may hit the LSP to build the domain index — isn't run twice).
      const ctx = ctxOverride ?? (await opts.getContext());

      // Decide the constraint mechanism (issue #257). Only bother fetching the GBNF when the toggle is
      // on AND the backend is grammar-capable (a local OpenAI-compatible server) AND the host exposes a
      // grammar accessor (browser only) — otherwise the parse-and-repair fallback covers it. The fetch
      // is defensive: a throw / missing export degrades to repair rather than crashing the send.
      //
      // Gate the whole mechanism on `offerApply`: only GENERATIVE turns produce a `.koi` model to
      // constrain. An explanatory turn (Explain, `offerApply:false`) must stay plain prose — constraining
      // it to the grammar would force the model to answer with a `.koi` model instead of an explanation.
      const constrainOn = opts.getConstrainGrammar() && offerApply;
      let gbnf: string | null = null;
      if (constrainOn && opts.getGrammar && isGrammarCapable(provider, baseUrl)) {
        // Don't TRUST the URL that a loopback OpenAI endpoint honours a GBNF grammar (issue #446):
        // Ollama's OpenAI-compatible endpoint looks identical but ignores a top-level `grammar` (it
        // constrains via its own `format`), which would light a LYING "grammar-constrained" chip and skip
        // the repair loop. Probe the endpoint's ACTUAL behaviour (cached per endpoint) with a tiny
        // sentinel-only grammar, and only attach the real GBNF when the probe confirms the grammar took.
        // A not-capable / errored probe leaves `gbnf` null → `chooseMechanism` returns 'repair' → the
        // honest parse-and-repair path (and Task 1's gbnf self-heal is the belt-and-braces backstop).
        const honoursGrammar = await probeGrammarCapability(provider, baseUrl, (grammar) =>
          runAssistant({
            provider,
            baseUrl,
            apiKey,
            model: opts.getModel(),
            system: 'Probe.',
            messages: [{ role: 'user', content: 'ping' }],
            grammar,
            signal: aborter?.signal,
            // Stream nothing into the transcript and don't commit it — the probe is invisible plumbing.
            onText: () => {},
          }),
        );
        if (honoursGrammar) {
          try {
            gbnf = await opts.getGrammar();
          } catch {
            gbnf = null;
          }
        }
      }
      const mechanism = chooseMechanism(constrainOn, provider, baseUrl, !!gbnf);

      // #447: the compiler/edit tools and a GBNF grammar are mutually exclusive at the decoder — a
      // grammar that only accepts `.koi` can't also emit the tool-call JSON the agentic loop needs. So
      // when the grammar is EFFECTIVE for this turn (mechanism === 'gbnf'), grammar wins: we withhold
      // the tools entirely rather than advertise tools the GBNF would silently render uncallable. When
      // the grammar isn't effective ('off'/'repair' — non-capable backend, no GBNF, or an explanatory
      // turn) the tools run exactly as before. The settings UI also makes the two mutually exclusive
      // (prefs.ts), so this is the belt-and-braces guard for any stale/legacy both-on state.
      const toolsEffective = opts.getUseTools() && mechanism !== 'gbnf';

      // Build the per-turn multi-file staging session ONLY for a GENERATIVE workspace turn: offerApply
      // (an Explain turn must never stage/apply edits) AND tools are effective (so not a gbnf turn) AND
      // the host supplies the edit executor AND there are workspace files to edit across. The model's
      // writes land in `editSession`; after the turn resolves, `editSession.staged()` holds the files.
      const wsFiles =
        offerApply && toolsEffective && opts.runEditTool && opts.getWorkspaceFiles ? opts.getWorkspaceFiles() : null;
      const editSession = wsFiles && Object.keys(wsFiles).length > 0 ? createEditSession(wsFiles) : null;

      // The once-per-turn whole-staged-workspace validation (issue #474): the loop runs `validateStaged`
      // a single time at end of turn and hands the diagnostics back here via `onStagedValidation`, so
      // the change-set panel can show a write that broke the model BEFORE the user applies it.
      let stagedDiagnostics: string | null = null;

      full = await runAssistant({
        provider,
        baseUrl,
        apiKey,
        model: opts.getModel(),
        // In workspace mode, steer the model toward the multi-file edit tools (otherwise the primer's
        // "output one ```koine block" instruction wins and the change-set path never fires).
        system: editSession ? `${buildSystem(ctx)}\n\n${WORKSPACE_EDIT_GUIDE}` : buildSystem(ctx),
        messages,
        signal: aborter.signal,
        // Attach the grammar only on the grammar-constrained path; a no-op for providers that ignore it.
        ...(mechanism === 'gbnf' && gbnf ? { grammar: gbnf } : {}),
        onText: (delta) => {
          full += delta;
          replyBubble.textContent = full;
          transcript.scrollTop = transcript.scrollHeight;
        },
        // Withhold the tools when the user hasn't opted into the agentic loop (plain streaming request —
        // no `tools` ⇒ local servers stream instead of buffering), AND whenever the grammar is effective
        // for this turn (#447): a GBNF that only accepts `.koi` can't emit the tool-call JSON, so
        // advertising tools alongside it would silently disable them. `toolsEffective` folds in both.
        runCompilerTool: toolsEffective ? opts.runCompilerTool : undefined,
        // Offer the multi-file edit surface alongside the compiler tools when this is a workspace turn.
        ...(editSession && opts.runEditTool ? { editSession, runEditTool: opts.runEditTool } : {}),
        // Validate the staged workspace ONCE at end of turn (issue #474): bind the host validator to
        // this turn's session, and capture the diagnostics for the change-set panel below.
        ...(editSession && opts.validateStaged
          ? {
              validateStaged: () => opts.validateStaged!(editSession),
              onStagedValidation: (diagnostics: string) => {
                stagedDiagnostics = diagnostics;
              },
            }
          : {}),
        onToolCall: addToolStatus,
      });
      commitAssistantTurn(full);
      if (editSession && editSession.staged().length > 0) {
        // The model staged a multi-file change: render the body, then a reviewable per-file change set
        // the user accepts before any disk write (the single-file Apply gate is for non-staged replies).
        replyBubble.innerHTML = `<div class="koi-md">${renderMarkdown(full)}</div>`;
        // Keep a handle to this turn's change set so the NEXT send can supersede it (#473). The
        // onApply/onDiscard wrappers clear the ref once this set reaches a terminal state, so a later
        // send doesn't try to invalidate an already-applied or discarded panel.
        let handle: ChangeSetHandle | undefined;
        handle = renderChangeSet(
          replyBubble,
          editSession.staged(),
          wsFiles ?? {},
          {
            onApply: async (accepted) => {
              const result = (await opts.onApplyChangeSet?.(accepted)) ?? { failed: [] };
              if (result.failed.length === 0 && activeChangeSet === handle) activeChangeSet = null;
              return result;
            },
            onDiscard: () => {
              if (activeChangeSet === handle) activeChangeSet = null;
            },
            // A LIVE re-read at apply time (#473): the reviewed diff stays anchored on the send-time
            // `wsFiles`, but drift is judged against the CURRENT workspace text, so a concurrent edit
            // since SEND is detected and that file is skipped rather than clobbered.
            currentText: (relPath) => opts.getWorkspaceFiles?.()?.[relPath],
          },
          stagedDiagnostics,
        );
        activeChangeSet = handle;
      } else {
        // The apply-gate lives here: a constrained turn validates (and, on the repair path, re-prompts)
        // before "Apply to editor" is enabled, so unparseable text can never be applied (#257).
        await renderConstrainedReply(replyBubble, full, offerApply, mechanism, ctx);
      }
    } catch (e) {
      // Keep the stored history in lock-step with the transcript on both failure paths.
      const aborted = aborter?.signal.aborted ?? false;
      if (aborted && full.trim()) {
        // Stopped mid-stream with usable output: commit the (user, partial-assistant) pair so the
        // visible reply and the history agree, and still offer to apply a generated model.
        commitAssistantTurn(full);
        replyBubble.innerHTML = `<div class="koi-md">${renderMarkdown(full)}</div>`;
        const note = document.createElement('div');
        note.className = 'koi-assistant-stopped';
        note.textContent = 'Stopped.';
        replyBubble.appendChild(note);
        // Re-validate before offering Apply: a stopped stream can leave a truncated/invalid `.koi`,
        // so the partial must clear the same gate the live path enforces (#444).
        if (offerApply) await maybeOfferApply(replyBubble, full);
      } else {
        // Aborted with nothing, or a real error: roll the whole turn back from BOTH history and
        // transcript (no dangling user turn or orphaned tool lines), and restore the prompt to retry.
        messages.pop();
        userBubble.remove();
        for (const n of toolNodes) n.remove();
        input.value = prompt;
        if (aborted) {
          replyBubble.classList.add('koi-msg-error');
          replyBubble.textContent = 'Stopped.';
        } else {
          const raw = e instanceof Error ? e.message : String(e);
          // A rejected/invalid key (the pre-flight check only catches a BLANK key) surfaces a raw
          // "401 {json}" otherwise — turn it into actionable guidance. Other errors get their human
          // "message" extracted from any JSON body rather than dumping the whole blob.
          const isAuth = /\b401\b|authentication|invalid[\s_-]*(x-)?api[\s_-]*key|unauthor/i.test(raw);
          const jsonMsg = raw.match(/"message"\s*:\s*"([^"]+)"/)?.[1];
          if (isAuth) {
            replyBubble.classList.add('koi-msg-note');
            // "Rejected" only makes sense if a key was actually sent; a 401 with no usable key (a
            // keyless local/remote endpoint that still demands auth) is a missing-key situation, not
            // a bad one — so word it as "not configured" to match the pre-flight guard (#530).
            replyBubble.textContent = hasKey
              ? 'The provider rejected your API key. Check it in Settings → Assistant. '
              : 'No API key configured — add one in Settings → Assistant. ';
            const open = document.createElement('button');
            open.type = 'button';
            open.className = 'koi-link-btn';
            open.textContent = 'Open Settings';
            open.addEventListener('click', () => opts.onOpenPrefs());
            replyBubble.appendChild(open);
          } else {
            replyBubble.classList.add('koi-msg-error');
            replyBubble.textContent = 'Request failed: ' + (jsonMsg ?? raw);
          }
        }
      }
    } finally {
      aborter = null;
      setBusy(false);
      input.focus();
    }
  }

  sendBtn.addEventListener('click', () => void send(input.value));
  stopBtn.addEventListener('click', () => aborter?.abort());
  input.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      void send(input.value);
    }
  });

  return {
    focusInput() {
      input.focus();
    },
    syncWorkspace() {
      const key = opts.getWorkspaceKey();
      if (key === loadedKey) return;
      loadedKey = key;
      messages = loadChat(key);
      rebuildTranscript();
    },
    explainSelection() {
      void runExplain();
    },
  };
}
