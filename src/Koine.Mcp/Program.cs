namespace Koine.Mcp;

/// <summary>
/// Entry point for the Koine MCP server. It exposes the Koine.Compiler service API to AI agents so a
/// model can author a complete domain in .koi: validate it, compile it to C#/TypeScript/Python/
/// glossary/docs, format it, and read the language reference + real examples. Every tool is a thin
/// wrapper over Koine.Compiler — no compiler changes.
///
/// <para>Two transports, same tools:</para>
/// <list type="bullet">
///   <item>default (no <c>--http</c>) → stdio, for an editor/agent that spawns this as a child.</item>
///   <item><c>--http [--port N] [--host H]</c> → an HTTP (Streamable HTTP/SSE) host any MCP client
///   reaches by URL (e.g. LM Studio). See <see cref="StdioHost"/> / <see cref="HttpHost"/>.</item>
/// </list>
///
/// <para>An explicit namespaced entry class (rather than top-level statements) keeps a stray global
/// <c>Program</c> out of the assembly, so projects that reference Koine.Mcp as a library — the
/// <c>koine</c> CLI hosts it for <c>koine mcp</c> — don't get their own <c>Program</c> shadowed.</para>
/// </summary>
internal static class Program
{
    private static async Task Main(string[] args)
    {
        if (args.Contains("--http"))
        {
            await HttpHost.RunAsync(args);
        }
        else
        {
            await StdioHost.RunAsync(args);
        }
    }
}
