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
  repairToValid,
  type ConstraintMechanism,
} from '@/ai/grammarConstraint';
import { KOINE_PRIMER } from '@/ai/assistantTools';
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

export function createAssistantPanel(opts: AssistantPanelOptions): AssistantPanel {
  // The transcript for the workspace this panel is currently pointed at. Restored from storage on
  // mount and re-pointed by syncWorkspace() when the folder changes; loadedKey tracks which one.
  let messages: ChatMessage[] = loadChat(opts.getWorkspaceKey());
  let loadedKey = opts.getWorkspaceKey();
  let aborter: AbortController | null = null;

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

  // Append an "Apply to editor" affordance when the assistant produced a model.
  function maybeOfferApply(bubble: HTMLElement, markdown: string): void {
    const koine = extractKoine(markdown);
    if (koine) attachApplyButton(bubble, koine);
  }

  // A small status chip on an assistant turn ("grammar-constrained" / "parse-and-repair").
  function addChip(bubble: HTMLElement, label: string): void {
    const chip = document.createElement('span');
    chip.className = 'koi-assistant-chip';
    chip.textContent = label;
    bubble.appendChild(chip);
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
   *  • `gbnf`   → the output is valid by construction; we still validate ONCE (a "grammar-constrained"
   *               chip), enabling Apply only if it parses.
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

    const candidate = extractKoine(content);
    if (!candidate) return; // prose reply — nothing to apply or gate

    const validate = makeValidate();
    // Legacy / no-gate path: the toggle is off, or the host can't validate, so behave as before.
    if (mechanism === 'off' || !validate) {
      attachApplyButton(bubble, candidate);
      return;
    }

    addChip(bubble, mechanism === 'gbnf' ? 'grammar-constrained' : 'parse-and-repair');

    // The grammar-constrained candidate is valid by construction → validate once, never repair. The
    // repair path re-prompts the model up to MAX_REPAIR_ROUNDS times, showing a live "repair k/N" line.
    const maxRounds = mechanism === 'gbnf' ? 0 : MAX_REPAIR_ROUNDS;
    let counter: HTMLElement | null = null;
    if (mechanism === 'repair') {
      counter = document.createElement('div');
      counter.className = 'koi-assistant-repair-counter';
      bubble.appendChild(counter);
    }

    let round = 0;
    let result: { source: string; ok: boolean; rounds: number };
    try {
      result = await repairToValid(
        candidate,
        {
          validate,
          regenerate: async (previous, diagnostics) => {
            round++;
            if (counter) counter.textContent = `repair ${round}/${maxRounds}`;
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

    if (result.ok) {
      attachApplyButton(bubble, result.source);
    } else {
      const notice = document.createElement('div');
      notice.className = 'koi-assistant-invalid';
      notice.textContent =
        mechanism === 'repair'
          ? `Couldn't produce valid Koine after ${maxRounds} repair attempt${maxRounds === 1 ? '' : 's'} — Apply is disabled.`
          : "The generated model didn't parse — Apply is disabled.";
      bubble.appendChild(notice);
    }
  }

  // Render a finished assistant reply into a bubble: the markdown body, plus the "Apply to editor"
  // affordance unless this turn opted out (an explanatory turn whose reply must not be applied).
  // Shared by the live success path and transcript replay so the two never drift.
  function renderAssistantReply(bubble: HTMLElement, content: string, offerApply: boolean): void {
    bubble.innerHTML = `<div class="koi-md">${renderMarkdown(content)}</div>`;
    if (offerApply) maybeOfferApply(bubble, content);
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
    // A key is required for Anthropic and for any remote OpenAI-compatible endpoint; local servers
    // (Ollama / LM Studio on localhost) need no auth, so a blank key is fine there.
    const needsKey = provider === 'anthropic' || !isLocalProviderUrl(baseUrl);
    if (needsKey && !apiKey) {
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
      const constrainOn = opts.getConstrainGrammar();
      let gbnf: string | null = null;
      if (constrainOn && opts.getGrammar && isGrammarCapable(provider, baseUrl)) {
        try {
          gbnf = await opts.getGrammar();
        } catch {
          gbnf = null;
        }
      }
      const mechanism = chooseMechanism(constrainOn, provider, baseUrl, !!gbnf);

      full = await runAssistant({
        provider,
        baseUrl,
        apiKey,
        model: opts.getModel(),
        system: buildSystem(ctx),
        messages,
        signal: aborter.signal,
        // Attach the grammar only on the grammar-constrained path; a no-op for providers that ignore it.
        ...(mechanism === 'gbnf' && gbnf ? { grammar: gbnf } : {}),
        onText: (delta) => {
          full += delta;
          replyBubble.textContent = full;
          transcript.scrollTop = transcript.scrollHeight;
        },
        // Withhold the tools when the user hasn't opted into the agentic loop, so the model gets a
        // plain streaming request (no `tools` ⇒ local servers stream instead of buffering).
        runCompilerTool: opts.getUseTools() ? opts.runCompilerTool : undefined,
        onToolCall: addToolStatus,
      });
      commitAssistantTurn(full);
      // The apply-gate lives here: a constrained turn validates (and, on the repair path, re-prompts)
      // before "Apply to editor" is enabled, so unparseable text can never be applied (#257).
      await renderConstrainedReply(replyBubble, full, offerApply, mechanism, ctx);
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
        if (offerApply) maybeOfferApply(replyBubble, full);
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
            replyBubble.textContent = 'The provider rejected your API key. Check it in Settings → Assistant. ';
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
