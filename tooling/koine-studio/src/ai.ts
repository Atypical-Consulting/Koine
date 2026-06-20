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
import type { MessageParam, Tool, ToolResultBlockParam } from '@anthropic-ai/sdk/resources/messages';
import type OpenAiSdk from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { KOINE_TOOL_DEFS, KOINE_TOOLS, summarizeForChip, toAnthropicTool } from './assistantTools';

/** A turn in the assistant transcript. */
export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
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

/**
 * Anthropic Messages API path: top-level system prompt + adaptive thinking + streaming, with the same
 * bounded agentic tool loop as the OpenAI path. Intermediate tool turns stay LOCAL to this function —
 * only the terminating round's text is returned, so the caller's transcript stays clean.
 */
async function runAnthropic(req: AssistantRequest): Promise<string> {
  const Anthropic = await loadAnthropic();
  const client = new Anthropic({ apiKey: req.apiKey, dangerouslyAllowBrowser: true });

  const exec = req.runCompilerTool;
  const messages: MessageParam[] = req.messages.map((m) => ({ role: m.role, content: m.content }));

  let anyText = false;
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    // Offer tools until the last allowed round, where we drop them so the model must answer in text.
    const offerTools = exec && round < MAX_TOOL_ROUNDS;
    const stream = client.messages.stream(
      {
        model: req.model || DEFAULT_AI_MODEL,
        max_tokens: 8192,
        thinking: { type: 'adaptive' },
        system: req.system,
        messages,
        // Anthropic's `{name, description, input_schema}` tool shape. The cast bridges the neutral
        // `object` schema to the SDK's `Tool.InputSchema`, same as the OpenAI adapter's boundary cast.
        ...(offerTools ? { tools: KOINE_TOOL_DEFS.map(toAnthropicTool) as Tool[] } : {}),
      },
      { signal: req.signal },
    );

    // This round's text. A tool-call round's text is a "thinking" preamble: it never enters history,
    // and only the terminating round's text is returned below.
    let roundText = '';
    stream.on('text', (delta) => {
      roundText += delta;
      if (delta) anyText = true;
      req.onText(delta);
    });
    const final = await stream.finalMessage();

    // A safety-classifier refusal resolves normally (HTTP 200) with stop_reason 'refusal' and no
    // text — surface it as an error so the UI shows a message instead of a blank reply.
    if (final.stop_reason === 'refusal' && !anyText) {
      throw new Error('The model declined to respond to this request.');
    }

    // No tool request (or no executor / final round) → this round's text IS the answer.
    if (final.stop_reason !== 'tool_use' || !exec || round === MAX_TOOL_ROUNDS) {
      return roundText;
    }

    // Echo the assistant turn back verbatim — the API requires its thinking/text/tool_use blocks
    // returned unchanged before the matching tool_result turn.
    messages.push({ role: 'assistant', content: final.content });
    const toolResults: ToolResultBlockParam[] = [];
    for (const block of final.content) {
      if (block.type !== 'tool_use') continue;
      let result: string;
      try {
        result = await exec(block.name, JSON.stringify(block.input));
      } catch (e) {
        // A failed tool is recoverable: hand the error back as the result so the model can adapt.
        result = `Error: ${e instanceof Error ? e.message : String(e)}`;
      }
      req.onToolCall?.(block.name, summarizeForChip(block.name, result));
      toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result });
    }
    messages.push({ role: 'user', content: toolResults });
  }
  return '';
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

  const exec = req.runCompilerTool;
  // The conversation grows in place: each tool round appends the model's tool-call turn and our tool
  // results, then we re-ask. These intermediate turns stay LOCAL to this function — the caller's
  // transcript only ever sees the final assistant text, so its history/rollback stays simple.
  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: req.system },
    ...req.messages.map((m) => ({ role: m.role, content: m.content })),
  ];

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    // Offer tools until the last allowed round, where we drop them so the model must answer in text —
    // a hard stop against a model that would otherwise keep requesting tools forever.
    const offerTools = exec && round < MAX_TOOL_ROUNDS;
    const stream = await client.chat.completions.create(
      {
        model: req.model || DEFAULT_OPENAI_MODEL,
        stream: true,
        messages,
        ...(offerTools ? { tools: KOINE_TOOLS, tool_choice: 'auto' as const } : {}),
      },
      { signal: req.signal },
    );

    // Tool calls arrive as index-keyed delta fragments; the `arguments` pieces are NOT individually
    // valid JSON, so we concatenate per index and only parse once the stream completes.
    const calls = new Map<number, { id: string; name: string; args: string }>();
    let assistantText = '';
    let finish: string | null = null;
    for await (const chunk of stream) {
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta;
      if (delta?.content) {
        // Stream this round's text live. If the round turns out to be a tool call, its text was a
        // "thinking" preamble: the panel clears it (onToolCall) and it never enters history — only the
        // terminating round's text is returned below.
        assistantText += delta.content;
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

    // No tool request (or no executor / final round) → this round's text IS the answer. Returning only
    // this round's text (not earlier tool-round preambles) keeps the caller's history clean.
    if (finish !== 'tool_calls' || calls.size === 0 || !exec || round === MAX_TOOL_ROUNDS) {
      return assistantText;
    }

    // Synthesize an id for any call whose streamed deltas carried none, so the assistant tool_calls
    // entry and its tool result stay paired (and unique) even on a non-compliant local backend.
    const ordered = [...calls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([index, c]) => ({ ...c, id: c.id || `call_${index}` }));
    messages.push({
      role: 'assistant',
      content: assistantText || null,
      tool_calls: ordered.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args } })),
    });
    for (const c of ordered) {
      let result: string;
      try {
        result = await exec(c.name, c.args);
      } catch (e) {
        // A failed tool is recoverable: hand the error back as the tool result so the model can adapt.
        result = `Error: ${e instanceof Error ? e.message : String(e)}`;
      }
      req.onToolCall?.(c.name, summarizeForChip(c.name, result));
      messages.push({ role: 'tool', tool_call_id: c.id, content: result });
    }
  }
  return '';
}
