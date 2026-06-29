// The AI client behind inline (ghost-text) completions: given the buffer around the caret, ask the
// configured provider for a short continuation. It deliberately reuses the SAME provider plumbing as
// the chat panel — `runAssistant` (src/ai/ai.ts), the persisted provider/key/model (settings), and the
// `KOINE_PRIMER` — so inline suggestions stay in valid Koine shape and there is one place to configure
// AI in Studio. It is best-effort by contract: it NEVER throws and returns null on no-provider / abort /
// error, so a hiccup can never disrupt typing.
import { isLocalProviderUrl, runAssistant } from '@/ai/ai';
import { KOINE_PRIMER } from '@/ai/assistantTools';
import { loadSettings } from '@/settings/persistence';

/** What the editor hands the client: the buffer split at the caret, plus the document URI. */
export interface InlineRequestContext {
  /** Buffer text up to the caret. */
  before: string;
  /** Buffer text from the caret to the end. */
  after: string;
  /** The document URI (kept for future grounding/telemetry; not yet sent to the model). */
  uri: string;
}

/** Marks the caret inside the buffer so the model knows exactly where to continue from. */
export const CURSOR_MARKER = '<|cursor|>';

// Folded into the system prompt under the primer: narrows the chat-shaped model down to emitting ONLY
// the raw insertion text. Without this the same model would happily return a fenced block + prose.
const INLINE_INSTRUCTION = `You are providing an INLINE code completion inside a Koine (.koi) editor.
The buffer below is shown with the caret marked as ${CURSOR_MARKER}. Predict the single most likely
continuation AT the caret — typically the rest of the current line or the next line or two. Output ONLY
the raw text to insert at the caret: no markdown, no code fences, no commentary, and do not repeat the
text that is already before the caret. If there is no useful continuation, output nothing.`;

/** Unwrap a single ```fence``` the model may add despite instructions, then drop trailing whitespace
 *  (a dangling newline reads badly as ghost text). Leading whitespace is meaningful indentation, so
 *  it is preserved. */
function sanitize(text: string): string {
  const fenced = text.match(/^\s*```[\w-]*\n([\s\S]*?)\n?```\s*$/);
  return (fenced ? fenced[1] : text).replace(/\s+$/, '');
}

/**
 * Request a caret continuation from the configured provider. Returns the insertion text, or null when
 * no provider is usable (a key is required but absent), the request was aborted, the provider errored,
 * or the model offered nothing. Honors `signal` so an edit can abort an in-flight request.
 */
export async function requestInline(ctx: InlineRequestContext, signal: AbortSignal): Promise<string | null> {
  const s = loadSettings();
  // A key is required for Anthropic and for any remote OpenAI-compatible endpoint; keyless local
  // servers are fine. No key where one is needed ⇒ no provider configured ⇒ no-op (no surprise spend).
  if ((s.aiProvider === 'anthropic' || !isLocalProviderUrl(s.aiBaseUrl)) && !s.aiApiKey) return null;

  const user = `${ctx.before}${CURSOR_MARKER}${ctx.after}`;
  try {
    const text = await runAssistant({
      provider: s.aiProvider,
      baseUrl: s.aiBaseUrl,
      apiKey: s.aiApiKey,
      // Keep the Claude/OpenAI ids separate so switching providers can't send a Claude id to OpenAI;
      // a blank id lets ai.ts apply the provider-appropriate default.
      model: s.aiProvider === 'openai' ? s.aiModelOpenai : s.aiModel,
      temperature: s.aiTemperature,
      system: `${KOINE_PRIMER}\n\n${INLINE_INSTRUCTION}`,
      messages: [{ role: 'user', content: user }],
      // Inline completion only needs the final text; the streamed deltas are irrelevant here.
      onText: () => {},
      signal,
    });
    if (signal.aborted) return null;
    const cleaned = sanitize(text);
    return cleaned.length > 0 ? cleaned : null;
  } catch {
    // Abort / network / auth / API error — inline completion is best-effort and must never throw or
    // disrupt typing. A failure simply means no ghost text this round.
    return null;
  }
}
