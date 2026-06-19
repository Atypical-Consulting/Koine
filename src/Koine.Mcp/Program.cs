using Koine.Mcp;

// Entry point for the Koine MCP server. It exposes the Koine.Compiler service API to AI agents so a
// model can author a complete domain in .koi: validate it, compile it to C#/TypeScript/Python/
// glossary/docs, format it, and read the language reference + real examples. Every tool is a thin
// wrapper over Koine.Compiler — no compiler changes.
//
// Two transports, same tools:
//   • default (no --http) → stdio, for an editor/agent that spawns this as a child process.
//   • --http [--port N] [--host H] → an HTTP (Streamable HTTP/SSE) host any MCP client reaches by
//     URL (e.g. LM Studio). See StdioHost / HttpHost.
if (args.Contains("--http"))
{
    await HttpHost.RunAsync(args);
}
else
{
    await StdioHost.RunAsync(args);
}
