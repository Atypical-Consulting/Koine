import { describe, it, expect, vi } from 'vitest';
import { createAcpClient } from '@/acp/client';
import type { AcpTransport, AgentSpec } from '@/host/types';

// A fake transport standing in for the Tauri broker, plus a scripted agent on the other end of it.
// This is deliberately NOT the SDK's in-process `connect(agentApp)` helper: what needs proving here is
// OUR wiring — that a callback transport is adapted into the SDK's Stream correctly, that requests
// come out as newline-free JSON, and that notifications reach the caller in order. An in-process
// connection would bypass exactly that code.

/** A JSON-RPC envelope as it appears on the wire between us and the agent. */
interface Wire {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
}

class FakeTransport implements AcpTransport {
  readonly sent: Wire[] = [];
  started: AgentSpec | null = null;
  stopped = false;
  /** Set by the test to make `start` fail, standing in for a command that does not exist. */
  startError: Error | null = null;
  private msgCb?: (json: string) => void;
  private exitCb?: (code: number) => void;
  /** Called with each outbound envelope so a test can script the agent's replies. */
  onOutbound?: (msg: Wire) => void;

  onMessage(cb: (json: string) => void): void {
    this.msgCb = cb;
  }
  onExit(cb: (code: number) => void): void {
    this.exitCb = cb;
  }
  /** Push a raw stdout line that is NOT a protocol message (an npx banner, a progress line). */
  deliverRaw(line: string): void {
    this.msgCb?.(line);
  }
  /** Report the agent's death, as the broker's `acp://exit` event would. */
  die(code: number): void {
    this.exitCb?.(code);
  }
  async start(spec: AgentSpec): Promise<void> {
    if (this.startError) throw this.startError;
    this.started = spec;
  }
  async send(message: string): Promise<void> {
    expect(message).not.toContain('\n'); // the Rust broker refuses embedded newlines; never send one
    const msg = JSON.parse(message) as Wire;
    this.sent.push(msg);
    this.onOutbound?.(msg);
  }
  async stop(): Promise<void> {
    this.stopped = true;
  }
  /** Push one agent→client message, as the Rust broker's `acp://message` event would. */
  deliver(msg: Record<string, unknown>): void {
    this.msgCb?.(JSON.stringify({ jsonrpc: '2.0', ...msg }));
  }
}

const SPEC: AgentSpec = { command: 'npx', args: ['@zed-industries/claude-code-acp'], cwd: '/w' };

/** Reply to `method` with `result`, on the next microtask (as a real agent would: never inline). */
function replyTo(t: FakeTransport, method: string, result: unknown): void {
  const prior = t.onOutbound;
  t.onOutbound = (msg) => {
    prior?.(msg);
    if (msg.method === method && msg.id !== undefined) {
      queueMicrotask(() => t.deliver({ id: msg.id, result }));
    }
  };
}

const AGENT_CAPS = { loadSession: true, promptCapabilities: { image: false } };

function initResult() {
  return { protocolVersion: 1, agentCapabilities: AGENT_CAPS, authMethods: [] };
}

describe('createAcpClient', () => {
  it('initialize() spawns the agent, negotiates, and exposes the agent capabilities', async () => {
    const t = new FakeTransport();
    replyTo(t, 'initialize', initResult());
    const client = createAcpClient(t);

    expect(client.capabilities).toBeNull(); // nothing negotiated yet
    const res = await client.initialize(SPEC);

    expect(t.started).toEqual(SPEC); // the transport was started before any message went out
    expect(t.sent[0]?.method).toBe('initialize');
    expect(res.agentCapabilities).toEqual(AGENT_CAPS);
    expect(client.capabilities).toEqual(AGENT_CAPS); // …and cached, so callers can gate optional methods
  });

  it('newSession() sends cwd and the MCP servers it was given, and returns the session id', async () => {
    const t = new FakeTransport();
    replyTo(t, 'initialize', initResult());
    replyTo(t, 'session/new', { sessionId: 'sess-1' });
    const client = createAcpClient(t);
    await client.initialize(SPEC);

    // Shaped exactly as Task 8 will send Koine's own MCP server. `headers` is REQUIRED on an HTTP
    // entry and `mcpServers` is required on `session/new` at all — both learned from the SDK's types,
    // not guessed: an agent gets an empty list rather than an absent field when there is nothing to
    // hand it.
    const mcpServers = [
      { type: 'http' as const, name: 'koine', url: 'http://127.0.0.1:8123/mcp', headers: [] },
    ];
    const id = await client.newSession({ cwd: '/w', mcpServers });

    expect(id).toBe('sess-1');
    const req = t.sent.find((m) => m.method === 'session/new');
    expect(req?.params).toMatchObject({ cwd: '/w', mcpServers });
  });

  it('prompt() streams agent_message_chunk deltas to onText IN ORDER and resolves the stop reason', async () => {
    const t = new FakeTransport();
    replyTo(t, 'initialize', initResult());
    replyTo(t, 'session/new', { sessionId: 'sess-1' });

    // Script the agent: on session/prompt, emit three chunks then answer with a stop reason.
    const prior = t.onOutbound;
    t.onOutbound = (msg) => {
      prior?.(msg);
      if (msg.method !== 'session/prompt') return;
      queueMicrotask(() => {
        for (const text of ['Hello', ', ', 'world']) {
          t.deliver({
            method: 'session/update',
            params: {
              sessionId: 'sess-1',
              update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
            },
          });
        }
        t.deliver({ id: msg.id, result: { stopReason: 'end_turn' } });
      });
    };

    const client = createAcpClient(t);
    await client.initialize(SPEC);
    await client.newSession({ cwd: '/w', mcpServers: [] });

    const deltas: string[] = [];
    const stopReason = await client.prompt('hi', { onText: (d) => deltas.push(d) });

    expect(deltas).toEqual(['Hello', ', ', 'world']);
    expect(stopReason).toBe('end_turn');
  });

  it('prompt() routes agent_thought_chunk to onThought, never to onText', async () => {
    const t = new FakeTransport();
    replyTo(t, 'initialize', initResult());
    replyTo(t, 'session/new', { sessionId: 'sess-1' });

    const prior = t.onOutbound;
    t.onOutbound = (msg) => {
      prior?.(msg);
      if (msg.method !== 'session/prompt') return;
      queueMicrotask(() => {
        t.deliver({
          method: 'session/update',
          params: {
            sessionId: 'sess-1',
            update: {
              sessionUpdate: 'agent_thought_chunk',
              content: { type: 'text', text: 'thinking…' },
            },
          },
        });
        t.deliver({ id: msg.id, result: { stopReason: 'end_turn' } });
      });
    };

    const client = createAcpClient(t);
    await client.initialize(SPEC);
    await client.newSession({ cwd: '/w', mcpServers: [] });

    const onText = vi.fn();
    const onThought = vi.fn();
    await client.prompt('hi', { onText, onThought });

    expect(onThought).toHaveBeenCalledWith('thinking…');
    expect(onText).not.toHaveBeenCalled();
  });

  it('cancel() notifies the agent for the live session', async () => {
    const t = new FakeTransport();
    replyTo(t, 'initialize', initResult());
    replyTo(t, 'session/new', { sessionId: 'sess-1' });
    const client = createAcpClient(t);
    await client.initialize(SPEC);
    await client.newSession({ cwd: '/w', mcpServers: [] });

    await client.cancel();

    const cancel = t.sent.find((m) => m.method === 'session/cancel');
    expect(cancel?.params).toEqual({ sessionId: 'sess-1' });
    expect(cancel?.id).toBeUndefined(); // a notification, not a request — it must never await a reply
  });

  it('rejects a prompt before a session exists rather than sending a malformed request', async () => {
    const t = new FakeTransport();
    replyTo(t, 'initialize', initResult());
    const client = createAcpClient(t);
    await client.initialize(SPEC);

    await expect(client.prompt('hi', {})).rejects.toThrow(/session/i);
    expect(t.sent.some((m) => m.method === 'session/prompt')).toBe(false);
  });

  it('cancel() before a session exists is a no-op, not a throw', async () => {
    const t = new FakeTransport();
    const client = createAcpClient(t);
    await expect(client.cancel()).resolves.toBeUndefined();
    expect(t.sent).toHaveLength(0);
  });

  it('close() stops the agent through the transport and forgets its capabilities', async () => {
    const t = new FakeTransport();
    replyTo(t, 'initialize', initResult());
    const client = createAcpClient(t);
    await client.initialize(SPEC);
    expect(client.capabilities).not.toBeNull();

    await client.close();

    expect(t.stopped).toBe(true);
    // Capabilities gate optional affordances; keeping a dead agent's would offer session-resume or
    // image attachment against a connection that no longer exists.
    expect(client.capabilities).toBeNull();
    expect(client.sessionId).toBeNull();
  });
});

// Everything below is a regression guard for a code-review finding on the spike (#1972). Each test
// names the failure it prevents, because none of them is obvious from the happy path.
describe('createAcpClient — hostile-agent and lifecycle guards', () => {
  it('survives a non-JSON stdout line instead of wedging the turn', async () => {
    // `npx` prints "Need to install the following packages… Ok to proceed? (y)" on a cold cache, and
    // ADR 0022 ships two `npx …` agents by default. An unguarded JSON.parse would throw inside the
    // Tauri event dispatch, where nothing catches it, and `initialize` would never settle.
    const t = new FakeTransport();
    t.onOutbound = (msg) => {
      if (msg.method !== 'initialize') return;
      queueMicrotask(() => {
        t.deliverRaw('Need to install the following packages:');
        t.deliverRaw('@zed-industries/claude-code-acp@0.16.2');
        t.deliverRaw('Ok to proceed? (y)');
        // …and then the real response arrives on the very same stream.
        t.deliver({ id: msg.id, result: initResult() });
      });
    };
    const client = createAcpClient(t);

    await expect(client.initialize(SPEC)).resolves.toMatchObject({
      agentCapabilities: AGENT_CAPS,
    });
  });

  it('rejects the in-flight request when the agent dies, rather than hanging forever', async () => {
    const t = new FakeTransport();
    const client = createAcpClient(t);
    const pending = client.initialize(SPEC);

    t.die(137); // OOM-killed

    await expect(pending).rejects.toThrow(/exited with code 137/);
  });

  it('answers session/request_permission instead of letting the SDK return -32601', async () => {
    // Not gated by any client capability: an unregistered handler makes every tool-using agent abort
    // its turn. `cancelled` is the honest answer until the dialog exists (Task 5) — it declines, it
    // does not crash, and it never fabricates consent.
    const t = new FakeTransport();
    replyTo(t, 'initialize', initResult());
    const client = createAcpClient(t);
    await client.initialize(SPEC);

    t.deliver({
      id: 99,
      method: 'session/request_permission',
      params: {
        sessionId: 'sess-1',
        toolCall: { toolCallId: 'tc-1', title: 'Write file' },
        options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
      },
    });
    await new Promise((r) => setTimeout(r, 0));

    const reply = t.sent.find((m) => m.id === 99);
    expect(reply?.result).toEqual({ outcome: { outcome: 'cancelled' } });
  });

  it('refuses a second initialize instead of orphaning the first connection', async () => {
    const t = new FakeTransport();
    replyTo(t, 'initialize', initResult());
    const client = createAcpClient(t);
    await client.initialize(SPEC);
    await expect(client.initialize(SPEC)).rejects.toThrow(/already initialized/i);
  });

  it('stays uninitialized when the agent cannot be spawned', async () => {
    // Otherwise `connection` is live-looking with no process behind it, and the next call writes into
    // a stream nobody is reading instead of failing with a clear message.
    const t = new FakeTransport();
    t.startError = new Error('failed to spawn ACP agent `nope`');
    const client = createAcpClient(t);

    await expect(client.initialize(SPEC)).rejects.toThrow(/spawn/);
    await expect(client.newSession({ cwd: '/w', mcpServers: [] })).rejects.toThrow(/not initialized/i);
  });

  it('does not send a turn whose signal is ALREADY aborted', async () => {
    // `addEventListener('abort')` never fires on an already-aborted signal, so the listener alone
    // would let the prompt through and never cancel it.
    const t = new FakeTransport();
    replyTo(t, 'initialize', initResult());
    replyTo(t, 'session/new', { sessionId: 'sess-1' });
    const client = createAcpClient(t);
    await client.initialize(SPEC);
    await client.newSession({ cwd: '/w', mcpServers: [] });

    const controller = new AbortController();
    controller.abort();
    await expect(client.prompt('hi', { signal: controller.signal })).rejects.toThrow(/abort/i);
    expect(t.sent.some((m) => m.method === 'session/prompt')).toBe(false);
  });

  it('drops chunks addressed to a different session', async () => {
    const t = new FakeTransport();
    replyTo(t, 'initialize', initResult());
    replyTo(t, 'session/new', { sessionId: 'sess-1' });

    const prior = t.onOutbound;
    t.onOutbound = (msg) => {
      prior?.(msg);
      if (msg.method !== 'session/prompt') return;
      queueMicrotask(() => {
        // A late notification from a session that is no longer current must not be appended.
        t.deliver({
          method: 'session/update',
          params: {
            sessionId: 'sess-OLD',
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'stale' } },
          },
        });
        t.deliver({
          method: 'session/update',
          params: {
            sessionId: 'sess-1',
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'fresh' } },
          },
        });
        t.deliver({ id: msg.id, result: { stopReason: 'end_turn' } });
      });
    };

    const client = createAcpClient(t);
    await client.initialize(SPEC);
    await client.newSession({ cwd: '/w', mcpServers: [] });

    const deltas: string[] = [];
    await client.prompt('hi', { onText: (d) => deltas.push(d) });
    expect(deltas).toEqual(['fresh']);
  });
});
