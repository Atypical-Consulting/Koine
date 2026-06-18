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
import type OpenAiSdk from 'openai';

/** A turn in the assistant transcript. */
export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

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
}

/**
 * Stream a completion from the configured provider, forwarding text deltas to `onText` and
 * resolving with the full text. Throws on auth/network/API errors (the caller renders the message).
 */
export function runAssistant(req: AssistantRequest): Promise<string> {
  return req.provider === 'openai' ? runOpenAiCompatible(req) : runAnthropic(req);
}

/** Anthropic Messages API path: top-level system prompt + adaptive thinking + streaming. */
async function runAnthropic(req: AssistantRequest): Promise<string> {
  const Anthropic = await loadAnthropic();
  const client = new Anthropic({ apiKey: req.apiKey, dangerouslyAllowBrowser: true });

  const stream = client.messages.stream(
    {
      model: req.model || DEFAULT_AI_MODEL,
      max_tokens: 8192,
      thinking: { type: 'adaptive' },
      system: req.system,
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
    },
    { signal: req.signal },
  );

  let full = '';
  stream.on('text', (delta) => {
    full += delta;
    req.onText(delta);
  });
  const final = await stream.finalMessage();
  // A safety-classifier refusal resolves normally (HTTP 200) with stop_reason 'refusal' and no
  // text — surface it as an error so the UI shows a message instead of a blank reply.
  if (final.stop_reason === 'refusal' && !full.trim()) {
    throw new Error('The model declined to respond to this request.');
  }
  return full;
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

  const stream = await client.chat.completions.create(
    {
      model: req.model || DEFAULT_OPENAI_MODEL,
      stream: true,
      messages: [
        { role: 'system', content: req.system },
        ...req.messages.map((m) => ({ role: m.role, content: m.content })),
      ],
    },
    { signal: req.signal },
  );

  let full = '';
  for await (const chunk of stream) {
    const delta = chunk.choices?.[0]?.delta?.content;
    if (delta) {
      full += delta;
      req.onText(delta);
    }
  }
  return full;
}
