// Builds the ready-to-paste `mcp.json` an MCP client (LM Studio, …) uses to reach Koine's tools
// over HTTP by URL. Pure + tiny so it is unit-tested and shared by the desktop Settings affordance,
// which surfaces the endpoint the `koine mcp --http` sidecar binds.

/** The `mcp.json` entry pointing a client at Koine's HTTP MCP endpoint, pretty-printed (2-space). */
export function mcpJsonSnippet(url: string): string {
  return JSON.stringify({ mcpServers: { koine: { url } } }, null, 2);
}
