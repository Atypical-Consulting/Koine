// Builds the ready-to-paste config an MCP client (LM Studio, Claude Desktop, Cursor, …) uses to reach
// Koine's tools, and a tiny loopback probe the Settings panel runs to confirm the endpoint is live.
// Pure + DOM-free so every piece is unit-tested; the only impure seam is the injected `fetchFn`.

import type { McpClientId } from './store';

/** The `mcp.json` entry pointing a client at Koine's HTTP MCP endpoint, pretty-printed (2-space). */
export function mcpHttpSnippet(url: string): string {
  return JSON.stringify({ mcpServers: { koine: { url } } }, null, 2);
}

/** Back-compat alias: the original HTTP-snippet name, still used by the endpoint Copy button. */
export const mcpJsonSnippet = mcpHttpSnippet;

/** The stdio recipe — for clients that spawn the server (Claude Desktop). Port-independent. */
export function mcpStdioSnippet(): string {
  return JSON.stringify({ mcpServers: { koine: { command: 'koine-mcp' } } }, null, 2);
}

/** One MCP client's setup recipe. The UI is data-driven off this table — a new client is one entry. */
export interface McpClientRecipe {
  id: McpClientId;
  label: string;
  /** `stdio` clients spawn `koine-mcp`; `http` clients connect to the sidecar URL. */
  transport: 'stdio' | 'http';
  /** The copy-paste config for this client; `url` is ignored for stdio recipes. */
  snippet(url: string): string;
  /** Where the config file lives / how to apply it. */
  configHint: string;
  /** Optional extra caveat (e.g. the tool-capable-model requirement). */
  note?: string;
}

/** The supported MCP clients and their copy-paste recipes, shown in Settings → MCP. */
export const MCP_CLIENTS: readonly McpClientRecipe[] = [
  {
    id: 'claude-desktop',
    label: 'Claude Desktop',
    transport: 'stdio',
    snippet: () => mcpStdioSnippet(),
    configHint: 'Paste into claude_desktop_config.json, then fully quit and reopen Claude Desktop.',
    note: 'Requires the koine-mcp tool on PATH (dotnet tool install -g Koine.Mcp).',
  },
  {
    id: 'lm-studio',
    label: 'LM Studio',
    transport: 'http',
    snippet: (url) => mcpHttpSnippet(url),
    configHint: 'Paste into mcp.json (LM Studio → Program → Edit mcp.json).',
    note: 'Pick a tool-capable model, or the agent cannot call koine_validate & friends.',
  },
  {
    id: 'cursor',
    label: 'Cursor',
    transport: 'http',
    snippet: (url) => mcpHttpSnippet(url),
    configHint: 'Paste into .cursor/mcp.json (project) or ~/.cursor/mcp.json (global).',
  },
  {
    id: 'vscode',
    label: 'VS Code',
    transport: 'http',
    snippet: (url) => mcpHttpSnippet(url),
    configHint: 'Paste into .vscode/mcp.json, then start the server from the MCP view.',
  },
  {
    id: 'generic',
    label: 'Generic (HTTP)',
    transport: 'http',
    snippet: (url) => mcpHttpSnippet(url),
    configHint: 'Point any URL-based MCP client at this endpoint.',
  },
];

// --- connection probe --------------------------------------------------------
// Studio acts as a minimal Streamable-HTTP MCP client to confirm the endpoint the user's LLM will
// hit is live and serving the koine_* tools. The request bodies + response parsing are pure; the
// transport is the injected `fetchFn` so the logic is testable without a live server.

/** The MCP protocol version Studio advertises when probing (latest at time of writing). */
const PROTOCOL_VERSION = '2025-06-18';

/** The JSON-RPC `initialize` request body. */
export function mcpInitializeBody(): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'koine-studio', version: '0' },
    },
  });
}

/** The JSON-RPC `tools/list` request body. */
export function mcpToolsListBody(): string {
  return JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
}

/** Pull tool names out of a `tools/list` JSON-RPC result, tolerating any unexpected shape. */
export function parseToolsList(json: unknown): string[] {
  const tools = (json as { result?: { tools?: { name?: unknown }[] } })?.result?.tools;
  if (!Array.isArray(tools)) return [];
  return tools.map((t) => (typeof t?.name === 'string' ? t.name : '')).filter(Boolean);
}

/** How long a connection probe waits, total, before giving up. */
const PROBE_TIMEOUT_MS = 4000;

/** Read a Streamable-HTTP response that may be a JSON body or an SSE stream. */
async function readRpc(res: Response): Promise<unknown> {
  const text = await res.text();
  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('text/event-stream')) {
    // An SSE response can carry heartbeats/notifications before the reply, so return the first
    // `data:` frame that parses to a JSON-RPC message (carries `result`/`error`) — not merely the
    // first `data:` line, which might be an unrelated event.
    for (const line of text.split('\n')) {
      if (!line.startsWith('data:')) continue;
      try {
        const msg = JSON.parse(line.slice(5).trim()) as Record<string, unknown>;
        if (msg && typeof msg === 'object' && ('result' in msg || 'error' in msg)) return msg;
      } catch {
        // a partial or non-JSON frame — keep scanning
      }
    }
    return {};
  }
  return text ? JSON.parse(text) : {};
}

/** The result of a connection probe: reachability plus the tool names the server advertises. */
export interface McpProbeResult {
  ok: boolean;
  tools: string[];
  error?: string;
}

/** How long a `tools/call` waits — longer than a probe, since it runs the compiler server-side. */
const TOOL_CALL_TIMEOUT_MS = 20000;

/** Pull the text payload out of a `tools/call` JSON-RPC result (its `content:[{type:'text',text}]`). */
function extractToolText(rpc: unknown): string {
  const r = rpc as {
    result?: { content?: { type?: string; text?: string }[]; isError?: boolean };
    error?: { message?: string };
  };
  if (r?.error) return `Error: ${r.error.message ?? 'MCP error'}`;
  const content = r?.result?.content;
  const text = Array.isArray(content)
    ? content.map((c) => (typeof c?.text === 'string' ? c.text : '')).filter(Boolean).join('\n')
    : '';
  // A tool-level failure (isError) is marked so the model treats it as a failed call, matching the
  // 'Error:' / 'compile failed' convention the browser formatters use.
  return r?.result?.isError ? `Error: ${text}` : text;
}

/**
 * Call one tool on a Koine MCP HTTP endpoint: `initialize` (capturing the `Mcp-Session-Id`) then
 * `tools/call` with `{ name, arguments }`, resolving the tool's text result. Used by the desktop
 * Assistant to run koine tools through the `koine mcp --http` sidecar. `fetchFn` is injectable.
 * Rejects on transport/HTTP failure (the caller turns that into a tool-error string for the model).
 */
export async function mcpCall(
  url: string,
  name: string,
  args: Record<string, unknown>,
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': PROTOCOL_VERSION,
  };
  const signal = AbortSignal.timeout(TOOL_CALL_TIMEOUT_MS);
  const initRes = await fetchFn(url, { method: 'POST', headers, body: mcpInitializeBody(), signal });
  if (!initRes.ok) throw new Error(`MCP initialize failed: HTTP ${initRes.status}`);
  await readRpc(initRes);
  const session = initRes.headers.get('mcp-session-id');
  const callRes = await fetchFn(url, {
    method: 'POST',
    headers: session ? { ...headers, 'mcp-session-id': session } : headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }),
    signal,
  });
  if (!callRes.ok) throw new Error(`MCP tools/call failed: HTTP ${callRes.status}`);
  return extractToolText(await readRpc(callRes));
}

/**
 * Probe a Koine MCP HTTP endpoint: `initialize` then `tools/list`, carrying the `Mcp-Session-Id`
 * the server hands back. Resolves `{ ok, tools }` — never rejects. `fetchFn` is injectable for tests.
 */
export async function probeMcp(url: string, fetchFn: typeof fetch = fetch): Promise<McpProbeResult> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    // The 2025-06-18 spec wants this on every request after `initialize`; send it from the start.
    'mcp-protocol-version': PROTOCOL_VERSION,
  };
  // One shared deadline across both round-trips, so a dead or stale-cached endpoint that never
  // answers can't pin the UI on "Checking…" until the OS connect timeout.
  const signal = AbortSignal.timeout(PROBE_TIMEOUT_MS);
  try {
    const initRes = await fetchFn(url, { method: 'POST', headers, body: mcpInitializeBody(), signal });
    if (!initRes.ok) return { ok: false, tools: [], error: `HTTP ${initRes.status}` };
    await readRpc(initRes);
    const session = initRes.headers.get('mcp-session-id');
    const listRes = await fetchFn(url, {
      method: 'POST',
      headers: session ? { ...headers, 'mcp-session-id': session } : headers,
      body: mcpToolsListBody(),
      signal,
    });
    // A non-2xx tools/list (e.g. a rejected session, or a protocol-version mismatch) is a failure —
    // without this check it would fall through to an empty tool list and read as "Connected — 0 tools".
    if (!listRes.ok) return { ok: false, tools: [], error: `HTTP ${listRes.status}` };
    const tools = parseToolsList(await readRpc(listRes));
    return { ok: true, tools };
  } catch (e) {
    return { ok: false, tools: [], error: e instanceof Error ? e.message : String(e) };
  }
}
