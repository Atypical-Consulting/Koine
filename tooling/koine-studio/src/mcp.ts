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
