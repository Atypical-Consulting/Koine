// AI copilot client — streams a reply from the configured provider, token by token. Two providers
// are supported, both via their official SDK (dynamically imported so they only load when the
// assistant is actually used, keeping them out of the main bundle):
//
//   • 'anthropic'  — the Anthropic Messages API (Claude Opus 4.8, adaptive thinking).
//   • 'openai'     — any OpenAI-compatible Chat Completions endpoint, selected by base URL:
//                    OpenAI (https://api.openai.com/v1), Ollama (http://localhost:11434/v1),
//                    LM Studio (http://localhost:1234/v1), Groq, Together, OpenRouter, …
//
// Everything runs in the user's browser/desktop with THEIR OWN key (or no key for a local server),
// hence `dangerouslyAllowBrowser` — the key is the user's own, on their own machine, in a local
// developer tool, not a shared server key.
import type AnthropicSdk from '@anthropic-ai/sdk';
import type { ContentBlock, MessageParam, Tool, ToolResultBlockParam, ToolUseBlock } from '@anthropic-ai/sdk/resources/messages';
import type OpenAiSdk from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { koineToolDefs, koineTools, summarizeForChip, toAnthropicTool } from '@/ai/assistantTools';

/** A turn in the assistant transcript. */
export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  /**
   * Transcript-only metadata (stripped before the turn is sent to a provider): false on an
   * explanatory assistant turn whose reply must NOT offer "Apply to editor", so the suppression
   * survives a reload/replay. Absent ⇒ apply is offered as usual.
   */
  offerApply?: boolean;
}

/** Most tool round-trips the agentic loop will run before forcing a final text answer. */
export const MAX_TOOL_ROUNDS = 5;

/** The configured AI backend. */
export type AiProvider = 'anthropic' | 'openai';

/** Default models per provider (used when the model field is blank). */
export const DEFAULT_AI_MODEL = 'claude-opus-4-8';
export const DEFAULT_OPENAI_MODEL = 'gpt-4o';
/** Default base URL for the OpenAI-compatible provider. */
export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';

/**
 * Whether a base URL points at a keyless local server (Ollama / LM Studio on loopback). This gates
 * whether an API key is required, so it lives in one place — both the chat panel and the inline
 * completion client share it rather than each keeping a copy of the regex that could drift apart.
 */
export function isLocalProviderUrl(baseUrl: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(baseUrl);
}

let anthropicPromise: Promise<typeof AnthropicSdk> | null = null;
let openaiPromise: Promise<typeof OpenAiSdk> | null = null;

async function loadAnthropic(): Promise<typeof AnthropicSdk> {
  if (!anthropicPromise) {
    anthropicPromise = import('@anthropic-ai/sdk').then((m) => m.default);
    // Don't cache a rejected import — null it so a retry re-imports (e.g. after the network recovers).
    anthropicPromise.catch(() => {
      anthropicPromise = null;
    });
  }
  return anthropicPromise;
}

async function loadOpenAi(): Promise<typeof OpenAiSdk> {
  if (!openaiPromise) {
    openaiPromise = import('openai').then((m) => m.default);
    openaiPromise.catch(() => {
      openaiPromise = null;
    });
  }
  return openaiPromise;
}

export interface AssistantRequest {
  provider: AiProvider;
  apiKey: string;
  /** Base URL for the OpenAI-compatible provider (ignored for 'anthropic'). */
  baseUrl?: string;
  model?: string;
  system: string;
  messages: ChatMessage[];
  /** Called with each streamed text delta. */
  onText: (delta: string) => void;
  /** Optional abort signal so the caller can cancel an in-flight request. */
  signal?: AbortSignal;
  /**
   * Execute a Koine compiler tool (validate/compile/format) by name with JSON args, resolving its
   * result as a string. When present, the assistant advertises the koine tools and runs an agentic
   * loop (both providers) so the model can call them; absent → plain chat.
   */
  runCompilerTool?: (name: string, argsJson: string) => Promise<string>;
  /** Notified each time the model invokes a tool, for transcript visibility (name + short status). */
  onToolCall?: (name: string, summary: string) => void;
}

/**
 * Stream a completion from the configured provider, forwarding text deltas to `onText` and
 * resolving with the full text. Throws on auth/network/API errors (the caller renders the message).
 */
export function runAssistant(req: AssistantRequest): Promise<string> {
  return req.provider === 'openai' ? runOpenAiCompatible(req) : runAnthropic(req);
}

// --- shared agentic tool loop ------------------------------------------------
// Both providers run the SAME bounded loop: advertise tools until the last round, stream a round, stop
// on a refusal / a final text answer / the round cap, otherwise execute the requested tools and feed
// the results back. Only the SDK-specific round streaming + turn shaping differs — captured by a
// ToolLoopAdapter — so the policy (cap, refusal, tool-error recovery, chip notifications) lives in one
// place and can't drift between providers.

/** A model's tool request, normalized across providers. `argsJson` is the JSON-stringified input. */
interface ToolCall {
  id: string;
  name: string;
  argsJson: string;
}

/** One streamed round, normalized: the text it produced and whether/which tools it asked for. */
interface ToolRound {
  /** Text streamed this round. A tool round's text is a "thinking" preamble — only the final wins. */
  text: string;
  toolCalls: ToolCall[];
  /** The round asked to run tools, so the loop should execute them and continue. */
  wantsTools: boolean;
  /** A safety-classifier refusal (Anthropic only); surfaced as an error when the round has no text. */
  refused: boolean;
  /** Provider-specific payload `recordToolRound` needs to echo the assistant turn back. */
  raw?: unknown;
}

interface ToolLoopAdapter {
  /** Stream one round, advertising tools when `offerTools`, forwarding text deltas to `onText`. */
  runRound(offerTools: boolean): Promise<ToolRound>;
  /** Append the assistant turn + the tool results to the provider's running message array. */
  recordToolRound(round: ToolRound, results: { id: string; content: string }[]): void;
}

/**
 * Drive a provider's adapter through the bounded agentic loop and resolve with the final text.
 * Intermediate tool turns stay in the adapter's local message array — only the terminating round's
 * text is returned, so the caller's transcript stays clean.
 */
async function runToolLoop(req: AssistantRequest, adapter: ToolLoopAdapter): Promise<string> {
  const exec = req.runCompilerTool;
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    // Offer tools until the last allowed round, where we drop them so the model must answer in text —
    // a hard stop against a model that would otherwise keep requesting tools forever.
    const r = await adapter.runRound(!!exec && round < MAX_TOOL_ROUNDS);

    // A refusal resolves normally (HTTP 200) with no usable text — surface it as an error so the UI
    // shows a message instead of a blank reply. Test this round's own (trimmed) text: a refusal can
    // land on a later round after a tool preamble, and an earlier round's text must not mask it.
    if (r.refused && !r.text.trim()) {
      throw new Error('The model declined to respond to this request.');
    }

    // No tool request (or no executor / final round) → this round's text IS the answer.
    if (!r.wantsTools || !exec || round === MAX_TOOL_ROUNDS) {
      return r.text;
    }

    const results: { id: string; content: string }[] = [];
    for (const c of r.toolCalls) {
      let result: string;
      try {
        result = await exec(c.name, c.argsJson);
      } catch (e) {
        // A failed tool is recoverable: hand the error back as the result so the model can adapt.
        result = `Error: ${e instanceof Error ? e.message : String(e)}`;
      }
      req.onToolCall?.(c.name, summarizeForChip(c.name, result));
      results.push({ id: c.id, content: result });
    }
    adapter.recordToolRound(r, results);
  }
  return '';
}

/**
 * Anthropic Messages API path: top-level system prompt + adaptive thinking + streaming, over the
 * shared agentic tool loop. The koine tools use Anthropic's `{name, description, input_schema}` shape.
 */
async function runAnthropic(req: AssistantRequest): Promise<string> {
  const Anthropic = await loadAnthropic();
  const client = new Anthropic({ apiKey: req.apiKey, dangerouslyAllowBrowser: true });
  const messages: MessageParam[] = req.messages.map((m) => ({ role: m.role, content: m.content }));

  return runToolLoop(req, {
    async runRound(offerTools) {
      const stream = client.messages.stream(
        {
          model: req.model || DEFAULT_AI_MODEL,
          max_tokens: 8192,
          thinking: { type: 'adaptive' },
          system: req.system,
          messages,
          // The cast bridges the neutral `object` schema to the SDK's `Tool.InputSchema`.
          ...(offerTools ? { tools: koineToolDefs().map(toAnthropicTool) as Tool[] } : {}),
        },
        { signal: req.signal },
      );
      let text = '';
      stream.on('text', (delta) => {
        text += delta;
        req.onText(delta);
      });
      const final = await stream.finalMessage();
      const toolCalls = final.content
        .filter((b): b is ToolUseBlock => b.type === 'tool_use')
        .map((b) => ({ id: b.id, name: b.name, argsJson: JSON.stringify(b.input) }));
      return {
        text,
        toolCalls,
        wantsTools: final.stop_reason === 'tool_use',
        refused: final.stop_reason === 'refusal',
        raw: final.content,
      };
    },
    recordToolRound(round, results) {
      // Echo the assistant turn back verbatim — the API requires its thinking/text/tool_use blocks
      // returned unchanged before the matching tool_result turn.
      messages.push({ role: 'assistant', content: round.raw as ContentBlock[] });
      messages.push({
        role: 'user',
        content: results.map((r): ToolResultBlockParam => ({ type: 'tool_result', tool_use_id: r.id, content: r.content })),
      });
    },
  });
}

/**
 * OpenAI-compatible Chat Completions path. The Koine system prompt is folded in as the leading
 * `system` message (these APIs have no top-level system field). A blank key is replaced with a
 * placeholder so local servers (Ollama / LM Studio), which need no auth, still construct a client.
 */
async function runOpenAiCompatible(req: AssistantRequest): Promise<string> {
  const OpenAI = await loadOpenAi();
  const client = new OpenAI({
    apiKey: req.apiKey || 'not-needed',
    baseURL: req.baseUrl || DEFAULT_OPENAI_BASE_URL,
    dangerouslyAllowBrowser: true,
  });
  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: req.system },
    ...req.messages.map((m) => ({ role: m.role, content: m.content })),
  ];

  return runToolLoop(req, {
    async runRound(offerTools) {
      const stream = await client.chat.completions.create(
        {
          model: req.model || DEFAULT_OPENAI_MODEL,
          stream: true,
          messages,
          ...(offerTools ? { tools: koineTools(), tool_choice: 'auto' as const } : {}),
        },
        { signal: req.signal },
      );

      // Tool calls arrive as index-keyed delta fragments; the `arguments` pieces are NOT individually
      // valid JSON, so we concatenate per index and only parse once the stream completes.
      const calls = new Map<number, { id: string; name: string; args: string }>();
      let text = '';
      let finish: string | null = null;
      for await (const chunk of stream) {
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta;
        if (delta?.content) {
          text += delta.content;
          req.onText(delta.content);
        }
        for (const tc of delta?.tool_calls ?? []) {
          const cur = calls.get(tc.index) ?? { id: '', name: '', args: '' };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name = tc.function.name;
          if (tc.function?.arguments) cur.args += tc.function.arguments;
          calls.set(tc.index, cur);
        }
        if (choice.finish_reason) finish = choice.finish_reason;
      }

      // Synthesize an id for any call whose streamed deltas carried none, so the assistant tool_calls
      // entry and its tool result stay paired (and unique) even on a non-compliant local backend.
      const ordered = [...calls.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([index, c]) => ({ ...c, id: c.id || `call_${index}` }));
      return {
        text,
        toolCalls: ordered.map((c) => ({ id: c.id, name: c.name, argsJson: c.args })),
        // Only treat the round as a tool request when the backend both flagged it AND emitted calls.
        wantsTools: finish === 'tool_calls' && calls.size > 0,
        refused: false,
        raw: ordered,
      };
    },
    recordToolRound(round, results) {
      const ordered = round.raw as { id: string; name: string; args: string }[];
      messages.push({
        role: 'assistant',
        content: round.text || null,
        tool_calls: ordered.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args } })),
      });
      for (const r of results) messages.push({ role: 'tool', tool_call_id: r.id, content: r.content });
    },
  });
}
