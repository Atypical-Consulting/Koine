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
  private msgCb?: (json: string) => void;
  /** Called with each outbound envelope so a test can script the agent's replies. */
  onOutbound?: (msg: Wire) => void;

  onMessage(cb: (json: string) => void): void {
    this.msgCb = cb;
  }
  onExit(): void {
    /* the spike's client does not surface exit yet — Task 11 */
  }
  async start(spec: AgentSpec): Promise<void> {
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

  it('close() stops the agent through the transport', async () => {
    const t = new FakeTransport();
    replyTo(t, 'initialize', initResult());
    const client = createAcpClient(t);
    await client.initialize(SPEC);
    await client.close();
    expect(t.stopped).toBe(true);
  });
});
