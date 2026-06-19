// The Assistant inspector tab: a small chat UI over the Anthropic Messages API (src/ai.ts). It
// streams replies, keeps the current model + diagnostics in the system prompt so answers stay
// grounded in what's on screen, offers quick actions (explain diagnostics, suggest invariants,
// review, generate), and lets the user apply a generated `.koi` model straight into the editor.
//
// Needs a user-supplied Anthropic API key (set in Preferences, stored locally). With no key it
// shows a prompt to add one rather than calling the API.
import { runAssistant, type AiProvider, type ChatMessage } from './ai';
import { renderMarkdown } from './editor';

/** A snapshot of what's on screen, fed to the model as grounding context on every turn. */
export interface AssistantContext {
  fileName: string;
  source: string;
  diagnostics: { line: number; col: number; severity: 'error' | 'warning'; message: string }[];
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
  /** The current editor model + diagnostics, captured fresh on each send. */
  getContext: () => AssistantContext;
  /** Replace the active editor document with a generated model. */
  onApplyModel: (source: string) => void;
  /** Open Preferences (so the user can add their API key). */
  onOpenPrefs: () => void;
}

export interface AssistantPanel {
  /** Move keyboard focus into the prompt input. */
  focusInput(): void;
}

// A concise Koine primer so the model emits valid `.koi`. Mirrors README's construct table.
const KOINE_PRIMER = `You are an expert assistant embedded in Koine Studio, the IDE for **Koine** — a
domain-specific language for Domain-Driven Design. A Koine model compiles to idiomatic C#/TypeScript.

Koine essentials:
- A model is one or more \`context Name { ... }\` bounded contexts.
- \`value Name { field: Type  invariant <expr> "message" }\` — immutable value objects with invariants.
- \`enum Name { A, B, C }\` — closed sets.
- \`entity Name identified by NameId { field: Type ... }\` — entities with identity.
- \`aggregate Name root RootEntity { ...nested value/enum/entity... }\` — consistency boundaries.
- Inside an entity: \`command Verb(...) requires <guard>\`, \`create ...\`, \`emit Event(...)\`,
  and \`states EnumType { A -> B  B -> C }\` state machines.
- \`event Name { field: Type }\` and \`integration event Name { ... }\` (cross-context).
- \`spec Name on Type = <bool expr>\`, \`service Name { operation ...  usecase ... }\`, \`policy ...\`.
- \`repository\`, \`readmodel\`, \`query\` for the application/CQRS layer.
- \`contextmap { Upstream -> Downstream : conformist | shared-kernel { T } | anti-corruption-layer ... }\`.
- Primitive types: String, Int, Decimal, Bool, Instant. Collections: List<T>, Set<T>, Map<K,V>, Range.
- Defaults: \`status: OrderStatus = Draft\`. Computed: \`subtotal: Money = unitPrice * quantity\`.

When you write or revise a model, output the COMPLETE model in a single \`\`\`koine fenced code block so the
user can apply it in one click. Keep prose tight and DDD-focused.`;

/** Build the per-turn system prompt: the primer plus the live model + diagnostics. */
function buildSystem(ctx: AssistantContext): string {
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
  return parts.join('\n');
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
  const messages: ChatMessage[] = [];
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
      void send(action.build(opts.getContext()));
    });
    quick.appendChild(b);
  }

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

  // Append an "Apply to editor" affordance when the assistant produced a model.
  function maybeOfferApply(bubble: HTMLElement, markdown: string): void {
    const koine = extractKoine(markdown);
    if (!koine) return;
    const apply = document.createElement('button');
    apply.type = 'button';
    apply.className = 'koi-assistant-apply';
    apply.textContent = 'Apply to editor';
    apply.addEventListener('click', () => {
      opts.onApplyModel(koine);
      apply.textContent = 'Applied ✓';
      apply.disabled = true;
    });
    bubble.appendChild(apply);
  }

  async function send(text: string): Promise<void> {
    const prompt = text.trim();
    if (!prompt || busy()) return;

    const provider = opts.getProvider();
    const baseUrl = opts.getBaseUrl();
    const apiKey = opts.getApiKey();
    // A key is required for Anthropic and for any remote OpenAI-compatible endpoint; local servers
    // (Ollama / LM Studio on localhost) need no auth, so a blank key is fine there.
    const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(baseUrl);
    const needsKey = provider === 'anthropic' || !isLocal;
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

    aborter = new AbortController();
    setBusy(true);
    let full = '';
    try {
      full = await runAssistant({
        provider,
        baseUrl,
        apiKey,
        model: opts.getModel(),
        system: buildSystem(opts.getContext()),
        messages,
        signal: aborter.signal,
        onText: (delta) => {
          full += delta;
          replyBubble.textContent = full;
          transcript.scrollTop = transcript.scrollHeight;
        },
      });
      messages.push({ role: 'assistant', content: full });
      replyBubble.innerHTML = `<div class="koi-md">${renderMarkdown(full)}</div>`;
      maybeOfferApply(replyBubble, full);
    } catch (e) {
      // Keep the stored history in lock-step with the transcript on both failure paths.
      const aborted = aborter?.signal.aborted ?? false;
      if (aborted && full.trim()) {
        // Stopped mid-stream with usable output: commit the (user, partial-assistant) pair so the
        // visible reply and the history agree, and still offer to apply a generated model.
        messages.push({ role: 'assistant', content: full });
        replyBubble.innerHTML = `<div class="koi-md">${renderMarkdown(full)}</div>`;
        const note = document.createElement('div');
        note.className = 'koi-assistant-stopped';
        note.textContent = 'Stopped.';
        replyBubble.appendChild(note);
        maybeOfferApply(replyBubble, full);
      } else {
        // Aborted with nothing, or a real error: roll the whole turn back from BOTH history and
        // transcript (no dangling user turn), and restore the prompt so the user can retry.
        messages.pop();
        userBubble.remove();
        input.value = prompt;
        replyBubble.classList.add('koi-msg-error');
        replyBubble.textContent = aborted
          ? 'Stopped.'
          : 'Request failed: ' + (e instanceof Error ? e.message : String(e));
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
  };
}
