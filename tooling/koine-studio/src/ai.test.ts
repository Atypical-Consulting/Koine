import { describe, expect, test, vi, beforeEach } from 'vitest';
import { runAssistant, MAX_TOOL_ROUNDS, type AssistantRequest } from './ai';

// Mock the dynamically-imported OpenAI SDK: `new OpenAI()` exposes chat.completions.create, which we
// route to a per-test implementation so we can feed canned streamed chunks and inspect the params.
const h = vi.hoisted(() => ({ createImpl: null as null | ((params: unknown, opts: unknown) => unknown) }));
vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create: (params: unknown, opts: unknown) => h.createImpl!(params, opts) } };
    constructor(_opts: unknown) {}
  },
}));

/** An async-iterable over canned ChatCompletionChunk-shaped objects (what the SDK stream yields). */
function streamFrom(chunks: unknown[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c;
    },
  };
}

const TEXT = [
  { choices: [{ delta: { content: 'All ' }, finish_reason: null }] },
  { choices: [{ delta: { content: 'good ✓' }, finish_reason: 'stop' }] },
];

// One tool call streamed the way LM Studio does: id+name on the first delta, arguments in fragments
// (not individually valid JSON), terminated by a finish_reason='tool_calls' chunk.
const TOOLCALL = [
  { choices: [{ delta: { tool_calls: [{ index: 0, id: '42', type: 'function', function: { name: 'koine_validate', arguments: '' } }] }, finish_reason: null }] },
  { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"source":' } }] }, finish_reason: null }] },
  { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"context X {}"}' } }] }, finish_reason: null }] },
  { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
];

function baseReq(over: Partial<AssistantRequest> = {}): AssistantRequest {
  return {
    provider: 'openai',
    apiKey: '',
    baseUrl: 'http://localhost:1234/v1',
    model: 'devstral',
    system: 'sys',
    messages: [{ role: 'user', content: 'hi' }],
    onText: () => {},
    ...over,
  };
}

beforeEach(() => {
  h.createImpl = null;
});

describe('runOpenAiCompatible — plain chat (no executor)', () => {
  test('streams text and never advertises tools when runCompilerTool is absent', async () => {
    const params: Record<string, unknown>[] = [];
    h.createImpl = (p) => {
      params.push(p as Record<string, unknown>);
      return Promise.resolve(streamFrom(TEXT));
    };
    let streamed = '';
    const out = await runAssistant(baseReq({ onText: (d) => (streamed += d) }));
    expect(out).toBe('All good ✓');
    expect(streamed).toBe('All good ✓');
    expect(params).toHaveLength(1);
    expect(params[0].tools).toBeUndefined();
  });
});

describe('runOpenAiCompatible — agentic tool loop', () => {
  test('accumulates a streamed tool_call, executes it, feeds the result back, then returns text', async () => {
    const params: Record<string, unknown>[] = [];
    const queue = [streamFrom(TOOLCALL), streamFrom(TEXT)];
    h.createImpl = (p) => {
      params.push(p as Record<string, unknown>);
      return Promise.resolve(queue.shift());
    };
    const calls: { name: string; args: string }[] = [];
    const chips: string[] = [];
    const out = await runAssistant(
      baseReq({
        runCompilerTool: (name, args) => {
          calls.push({ name, args });
          return Promise.resolve('ok: true — no diagnostics.');
        },
        onToolCall: (name) => chips.push(name),
      }),
    );

    // The fragmented arguments concatenate to valid JSON and the tool ran once.
    expect(calls).toEqual([{ name: 'koine_validate', args: '{"source":"context X {}"}' }]);
    expect(chips).toEqual(['koine_validate']);
    expect(out).toBe('All good ✓');

    // First call advertises tools; the second carries the assistant tool_calls turn + the tool result.
    expect(params[0].tools).toBeTruthy();
    const sent = params[1].messages as { role: string; tool_call_id?: string; content?: unknown }[];
    expect(sent.some((m) => m.role === 'assistant' && Array.isArray((m as { tool_calls?: unknown[] }).tool_calls))).toBe(true);
    expect(sent.some((m) => m.role === 'tool' && m.tool_call_id === '42')).toBe(true);
  });

  test('a "thinking" preamble emitted alongside a tool_call does NOT leak into the returned answer', async () => {
    // Round 1: the model says something AND requests a tool. Round 2: the real answer.
    const preambleRound = [
      { choices: [{ delta: { content: 'Let me check that. ' }, finish_reason: null }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: '7', type: 'function', function: { name: 'koine_validate', arguments: '{"source":"x"}' } }] }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ];
    const queue = [streamFrom(preambleRound), streamFrom(TEXT)];
    const sent: { role: string; content?: unknown }[][] = [];
    h.createImpl = (p) => {
      sent.push((p as { messages: { role: string; content?: unknown }[] }).messages);
      return Promise.resolve(queue.shift());
    };
    const out = await runAssistant(baseReq({ runCompilerTool: () => Promise.resolve('ok') }));

    // Returned answer (→ history) is only the terminal round, not the preamble.
    expect(out).toBe('All good ✓');
    expect(out).not.toContain('Let me check');
    // …but the model still sees its own preamble as the tool-call message content.
    const assistantToolMsg = sent[1].find((m) => m.role === 'assistant' && Array.isArray((m as { tool_calls?: unknown[] }).tool_calls));
    expect(assistantToolMsg?.content).toBe('Let me check that. ');
  });

  test('synthesizes a tool_call id when the backend omits it (ids stay paired)', async () => {
    const noId = [
      { choices: [{ delta: { tool_calls: [{ index: 0, type: 'function', function: { name: 'koine_format', arguments: '{"source":"x"}' } }] }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ];
    const queue = [streamFrom(noId), streamFrom(TEXT)];
    const sent: { role: string; tool_call_id?: string; tool_calls?: { id: string }[] }[][] = [];
    h.createImpl = (p) => {
      sent.push((p as { messages: never[] }).messages);
      return Promise.resolve(queue.shift());
    };
    await runAssistant(baseReq({ runCompilerTool: () => Promise.resolve('ok') }));

    const second = sent[1];
    const assistantMsg = second.find((m) => Array.isArray(m.tool_calls));
    const toolMsg = second.find((m) => m.role === 'tool');
    expect(assistantMsg?.tool_calls?.[0].id).toBe('call_0');
    expect(toolMsg?.tool_call_id).toBe('call_0'); // paired with the synthesized id
  });

  test('caps tool rounds at MAX_TOOL_ROUNDS even if the model keeps requesting tools', async () => {
    h.createImpl = () => Promise.resolve(streamFrom(TOOLCALL)); // never stops asking for tools
    let n = 0;
    await runAssistant(
      baseReq({
        runCompilerTool: () => {
          n++;
          return Promise.resolve('x');
        },
      }),
    );
    expect(n).toBe(MAX_TOOL_ROUNDS);
  });

  test('a thrown executor becomes an error string fed back to the model (no crash)', async () => {
    const queue = [streamFrom(TOOLCALL), streamFrom(TEXT)];
    const sentTo: unknown[] = [];
    h.createImpl = (p) => {
      sentTo.push((p as { messages: unknown }).messages);
      return Promise.resolve(queue.shift());
    };
    const out = await runAssistant(
      baseReq({ runCompilerTool: () => Promise.reject(new Error('wasm boom')) }),
    );
    expect(out).toBe('All good ✓');
    const second = sentTo[1] as { role: string; content?: string }[];
    const toolMsg = second.find((m) => m.role === 'tool');
    expect(toolMsg?.content).toContain('wasm boom');
  });
});
