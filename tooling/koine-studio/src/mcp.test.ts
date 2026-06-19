import { describe, expect, test } from 'vitest';
import { mcpJsonSnippet, mcpStdioSnippet, MCP_CLIENTS, parseToolsList, probeMcp } from './mcp';
import { BrowserPlatform } from './host/browser';

describe('mcpJsonSnippet', () => {
  test('wraps the endpoint URL in the mcp.json a client pastes', () => {
    const url = 'http://127.0.0.1:50286/mcp';
    const snippet = mcpJsonSnippet(url);

    // Parses back to exactly { mcpServers: { koine: { url } } } — the shape LM Studio expects.
    expect(JSON.parse(snippet)).toEqual({ mcpServers: { koine: { url } } });
    // Pretty-printed (multi-line) so it is readable when pasted.
    expect(snippet).toContain('\n');
    expect(snippet).toContain('"koine"');
  });

  test('round-trips an arbitrary loopback URL verbatim', () => {
    const url = 'http://localhost:3001/mcp';
    expect(JSON.parse(mcpJsonSnippet(url)).mcpServers.koine.url).toBe(url);
  });
});

describe('MCP client recipes', () => {
  test('stdio snippet is the koine-mcp command block', () => {
    expect(JSON.parse(mcpStdioSnippet())).toEqual({ mcpServers: { koine: { command: 'koine-mcp' } } });
  });

  test('every client id has exactly one recipe with a non-empty hint', () => {
    const ids = MCP_CLIENTS.map((c) => c.id).sort();
    expect(ids).toEqual(['claude-desktop', 'cursor', 'generic', 'lm-studio', 'vscode']);
    for (const c of MCP_CLIENTS) expect(c.configHint.length).toBeGreaterThan(0);
  });

  test('http clients embed the url, stdio clients do not', () => {
    const url = 'http://127.0.0.1:50286/mcp';
    for (const c of MCP_CLIENTS) {
      const snip = c.snippet(url);
      if (c.transport === 'http') expect(snip).toContain(url);
      else expect(snip).toContain('koine-mcp');
    }
  });
});

describe('MCP probe', () => {
  const TOOLS = ['koine_validate', 'koine_compile', 'koine_format', 'koine_reference', 'koine_examples'];

  test('parseToolsList pulls tool names from a tools/list result', () => {
    const result = { result: { tools: TOOLS.map((name) => ({ name })) } };
    expect(parseToolsList(result)).toEqual(TOOLS);
    expect(parseToolsList({ nope: true })).toEqual([]);
  });

  test('probeMcp reports ok + tools from a JSON-bodied server', async () => {
    const fetchFn = ((_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const payload =
        body.method === 'initialize'
          ? { result: { serverInfo: { name: 'koine' } } }
          : { result: { tools: TOOLS.map((name) => ({ name })) } };
      return Promise.resolve(
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'content-type': 'application/json', 'mcp-session-id': 's1' },
        }),
      );
    }) as unknown as typeof fetch;
    await expect(probeMcp('http://127.0.0.1:1/mcp', fetchFn)).resolves.toEqual({ ok: true, tools: TOOLS });
  });

  test('probeMcp reads a tools/list delivered as an SSE stream', async () => {
    const fetchFn = ((_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const payload =
        body.method === 'initialize'
          ? { result: { serverInfo: { name: 'koine' } } }
          : { result: { tools: TOOLS.map((name) => ({ name })) } };
      return Promise.resolve(
        new Response(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
      );
    }) as unknown as typeof fetch;
    await expect(probeMcp('http://127.0.0.1:1/mcp', fetchFn)).resolves.toEqual({ ok: true, tools: TOOLS });
  });

  test('probeMcp reports not-ok when the server is unreachable', async () => {
    const fetchFn = (() => Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof fetch;
    const r = await probeMcp('http://127.0.0.1:1/mcp', fetchFn);
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });

  test('probeMcp reports not-ok on a non-2xx initialize', async () => {
    const fetchFn = (() =>
      Promise.resolve(new Response('nope', { status: 500 }))) as unknown as typeof fetch;
    const r = await probeMcp('http://127.0.0.1:1/mcp', fetchFn);
    expect(r.ok).toBe(false);
  });

  test('probeMcp reports not-ok when tools/list fails even though initialize succeeded', async () => {
    // A server that accepts the handshake but rejects tools/list (stale session, protocol mismatch…)
    // must read as "Not reachable", not "Connected — 0 tools".
    const fetchFn = ((_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      return body.method === 'initialize'
        ? Promise.resolve(
            new Response(JSON.stringify({ result: { serverInfo: { name: 'koine' } } }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
          )
        : Promise.resolve(new Response('bad session', { status: 400 }));
    }) as unknown as typeof fetch;
    const r = await probeMcp('http://127.0.0.1:1/mcp', fetchFn);
    expect(r.ok).toBe(false);
    expect(r.tools).toEqual([]);
  });
});

describe('BrowserPlatform.mcpEndpoint', () => {
  test('returns null — a browser tab cannot host an MCP server, so the affordance hides', async () => {
    await expect(new BrowserPlatform().mcpEndpoint()).resolves.toBeNull();
  });

  test('mcpStop resolves (no server to stop in a tab)', async () => {
    await expect(new BrowserPlatform().mcpStop()).resolves.toBeUndefined();
  });
});
