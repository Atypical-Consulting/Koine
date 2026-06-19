using System.ComponentModel;
using System.Globalization;
using Koine.Mcp;
using Spectre.Console.Cli;

namespace Koine.Cli.Commands;

/// <summary>
/// Runs the Koine MCP server, exposing the compiler tools (validate / compile / format / reference /
/// examples) to AI agents. Like <see cref="LspCommand"/> this speaks a raw protocol whose stdout
/// must never be decorated, so it delegates straight to the hosts in <c>Koine.Mcp</c>:
/// <list type="bullet">
///   <item><c>koine mcp</c> — stdio (an editor/agent spawns this as a child), the default.</item>
///   <item><c>koine mcp --http [--port N] [--host H]</c> — HTTP (Streamable HTTP/SSE) so any MCP
///   client connects by URL; the resolved endpoint is printed to stderr.</item>
/// </list>
/// The hosts are shared with the standalone <c>koine-mcp</c> tool, so there is one implementation.
/// </summary>
internal sealed class McpCommand : AsyncCommand<McpCommand.Settings>
{
    internal sealed class Settings : CommandSettings
    {
        [CommandOption("--http")]
        [Description("Serve over HTTP (Streamable HTTP/SSE) instead of stdio.")]
        public bool Http { get; init; }

        [CommandOption("--port <PORT>")]
        [Description("HTTP port (default 0 = OS-assigned). Used only with --http.")]
        public int Port { get; init; }

        [CommandOption("--host <HOST>")]
        [Description("HTTP bind address (default 127.0.0.1, loopback only). Used only with --http.")]
        public string? Host { get; init; }
    }

    protected override async Task<int> ExecuteAsync(CommandContext context, Settings settings, CancellationToken cancellationToken)
    {
        if (!settings.Http)
        {
            await StdioHost.RunAsync([]);
            return 0;
        }

        // Rebuild the flag vector HttpHost.ParseEndpoint understands so the endpoint parsing has a
        // single home (shared with the koine-mcp tool). A zero/omitted port stays OS-assigned.
        var args = new List<string> { "--http" };
        if (settings.Port != 0)
        {
            args.Add("--port");
            args.Add(settings.Port.ToString(CultureInfo.InvariantCulture));
        }

        if (!string.IsNullOrWhiteSpace(settings.Host))
        {
            args.Add("--host");
            args.Add(settings.Host);
        }

        await HttpHost.RunAsync(args.ToArray());
        return 0;
    }
}
