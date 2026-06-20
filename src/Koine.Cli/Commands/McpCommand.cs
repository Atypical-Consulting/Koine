using System.ComponentModel;
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

        // Reject an out-of-range port here so the CLI signals failure (exit 1) with a clear message
        // instead of letting Kestrel crash on the bind.
        if (!HttpHost.IsValidPort(settings.Port))
        {
            await Console.Error.WriteLineAsync($"error: port must be 0-65535 (got {settings.Port})");
            return 1;
        }

        // Delegate straight to the shared host with the parsed settings — no string[] round-trip.
        var host = string.IsNullOrWhiteSpace(settings.Host) ? HttpHost.DefaultHost : settings.Host;
        await HttpHost.RunAsync(host, settings.Port);
        return 0;
    }
}
