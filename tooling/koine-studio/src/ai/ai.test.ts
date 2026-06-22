import { describe, expect, test, vi, beforeEach } from 'vitest';
import { runAssistant, MAX_TOOL_ROUNDS, type AssistantRequest } from '@/ai/ai';

// Mock the dynamically-imported OpenAI SDK: `new OpenAI()` exposes chat.completions.create, which we
// route to a per-test implementation so we can feed canned streamed chunks and inspect the params.
// The Anthropic SDK is mocked the same way: `new Anthropic()` exposes messages.stream, routed to a
// per-test `streamImpl` that returns a canned stream object (see anthropicStream below).
const h = vi.hoisted(() => ({
  createImpl: null as null | ((params: unknown, opts: unknown) => unknown),
  streamImpl: null as null | ((params: unknown, opts: unknown) => unknown),
}));
vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create: (params: unknown, opts: unknown) => h.createImpl!(params, opts) } };
    constructor(_opts: unknown) {}
  },
}));
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { stream: (params: unknown, opts: unknown) => h.streamImpl!(params, opts) };
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

// A canned Anthropic stream: text callbacks fire synchronously on `.on('text', …)` registration (the
// real code registers the listener before awaiting finalMessage, so by-the-time semantics match).
function anthropicStream(spec: { textDeltas?: string[]; finalMessage: unknown }) {
  return {
    on(event: string, cb: (delta: string) => void) {
      if (event === 'text') for (const d of spec.textDeltas ?? []) cb(d);
      return this;
    },
    finalMessage() {
      return Promise.resolve(spec.finalMessage);
    },
  };
}

// Round 0: the model asks to run koine_validate. Round 1: the answer (Anthropic equivalents of the
// OpenAI TOOLCALL/TEXT fixtures above).
const A_TOOLCALL = {
  role: 'assistant',
  stop_reason: 'tool_use',
  content: [{ type: 'tool_use', id: 'tu_1', name: 'koine_validate', input: { source: 'context X {}' } }],
};
const A_TEXT = {
  textDeltas: ['All ', 'good ✓'],
  finalMessage: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'All good ✓' }] },
};

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

function anthropicReq(over: Partial<AssistantRequest> = {}): AssistantRequest {
  return baseReq({ provider: 'anthropic', apiKey: 'sk-test', baseUrl: undefined, model: undefined, ...over });
}

beforeEach(() => {
  h.createImpl = null;
  h.streamImpl = null;
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

describe('runAnthropic — agentic tool loop', () => {
  test('advertises Anthropic tools, runs koine_validate once, fires onToolCall, returns only the final text', async () => {
    const params: Record<string, unknown>[] = [];
    const queue = [anthropicStream({ finalMessage: A_TOOLCALL }), anthropicStream(A_TEXT)];
    h.streamImpl = (p) => {
      params.push(p as Record<string, unknown>);
      return queue.shift();
    };
    const calls: { name: string; args: string }[] = [];
    const chips: string[] = [];
    const out = await runAssistant(
      anthropicReq({
        runCompilerTool: (name, args) => {
          calls.push({ name, args });
          return Promise.resolve('ok: true — no diagnostics.');
        },
        onToolCall: (name) => chips.push(name),
      }),
    );

    // Round 0 advertises tools in the Anthropic `input_schema` shape (not OpenAI's `parameters`).
    const tools = params[0].tools as { name: string; input_schema?: unknown; parameters?: unknown }[];
    expect(Array.isArray(tools)).toBe(true);
    expect(tools[0].input_schema).toBeTruthy();
    expect(tools[0].parameters).toBeUndefined();

    // The tool ran once with the JSON-stringified input; the chip fired; the answer is only round 1's text.
    expect(calls).toEqual([{ name: 'koine_validate', args: '{"source":"context X {}"}' }]);
    expect(chips).toEqual(['koine_validate']);
    expect(out).toBe('All good ✓');
  });

  test('no executor → no tools advertised, plain chat returns the text; a refusal with no text throws', async () => {
    const params: Record<string, unknown>[] = [];
    h.streamImpl = (p) => {
      params.push(p as Record<string, unknown>);
      return anthropicStream(A_TEXT);
    };
    let streamed = '';
    const out = await runAssistant(anthropicReq({ onText: (d) => (streamed += d) }));
    expect(out).toBe('All good ✓');
    expect(streamed).toBe('All good ✓');
    expect(params).toHaveLength(1);
    expect(params[0].tools).toBeUndefined();

    // A safety-classifier refusal with no text surfaces as an error.
    h.streamImpl = () =>
      anthropicStream({ finalMessage: { role: 'assistant', stop_reason: 'refusal', content: [] } });
    await expect(runAssistant(anthropicReq())).rejects.toThrow('The model declined to respond to this request.');
  });

  test('caps tool rounds at MAX_TOOL_ROUNDS; a thrown executor is fed back as a tool_result', async () => {
    // The model never stops asking for tools, and the executor always throws.
    const sentTo: unknown[] = [];
    h.streamImpl = (p) => {
      sentTo.push((p as { messages: unknown }).messages);
      return anthropicStream({ finalMessage: A_TOOLCALL });
    };
    let n = 0;
    const out = await runAssistant(
      anthropicReq({
        runCompilerTool: () => {
          n++;
          return Promise.reject(new Error('wasm boom'));
        },
      }),
    );
    // Tools dropped on the final round → exactly MAX_TOOL_ROUNDS executions, no crash.
    expect(n).toBe(MAX_TOOL_ROUNDS);
    expect(typeof out).toBe('string');

    // The user turn pushed after round 0 carries a tool_result whose content includes the error text.
    const second = sentTo[1] as { role: string; content: { type: string; content?: string }[] }[];
    const userTurn = second.find((m) => m.role === 'user' && Array.isArray(m.content));
    const toolResult = userTurn?.content.find((b) => b.type === 'tool_result');
    expect(toolResult?.content).toContain('wasm boom');
  });

  test('a refusal on a LATER round is not masked by an earlier round’s preamble text', async () => {
    // Round 0 streams a "thinking" preamble and asks for a tool; round 1 is refused with no text.
    // The earlier preamble must NOT mask the refusal (regression: a cross-round text flag would).
    const queue = [
      anthropicStream({ textDeltas: ['Let me check that. '], finalMessage: A_TOOLCALL }),
      anthropicStream({ finalMessage: { role: 'assistant', stop_reason: 'refusal', content: [] } }),
    ];
    h.streamImpl = () => queue.shift();
    await expect(
      runAssistant(anthropicReq({ runCompilerTool: () => Promise.resolve('ok: true — no diagnostics.') })),
    ).rejects.toThrow('The model declined to respond to this request.');
  });
});
