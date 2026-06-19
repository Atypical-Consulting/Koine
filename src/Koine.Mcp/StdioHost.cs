using System.Reflection;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Koine.Mcp;

/// <summary>
/// Hosts the Koine MCP server over <b>stdio</b> — the default transport, used when an editor or
/// agent spawns <c>koine-mcp</c> (or <c>koine mcp</c>) as a child process and frames MCP messages
/// over the child's stdin/stdout. stdout therefore carries ONLY framed MCP messages, so every log
/// line is routed to stderr (the same constraint <c>LspServer.Run()</c> enforces).
///
/// <para>The tool and resource classes are discovered from <b>this</b> assembly explicitly (not the
/// entry assembly) so the host behaves identically whether it is launched as the standalone
/// <c>koine-mcp</c> tool or hosted in-process by the <c>koine</c> CLI (<c>koine mcp</c>), where the
/// entry assembly would otherwise be <c>Koine.Cli</c> and no tools would be found.</para>
/// </summary>
public static class StdioHost
{
    /// <summary>Runs the stdio MCP server until its input closes (the agent disconnects).</summary>
    public static async Task RunAsync(string[] args)
    {
        var builder = Host.CreateApplicationBuilder(args);

        builder.Logging.AddConsole(options =>
            options.LogToStandardErrorThreshold = LogLevel.Trace);

        var mcpAssembly = typeof(StdioHost).Assembly;
        builder.Services
            .AddMcpServer()
            .WithStdioServerTransport()
            .WithToolsFromAssembly(mcpAssembly)
            .WithResourcesFromAssembly(mcpAssembly);

        await builder.Build().RunAsync();
    }
}
