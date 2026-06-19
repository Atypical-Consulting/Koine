using System.Diagnostics;
using ModelContextProtocol.Client;

namespace Koine.Mcp.Tests;

/// <summary>
/// Covers the CLI surface end-to-end: launches the real <c>koine mcp --http --port 0</c> command as
/// a child process (the same binary Koine Studio ships and runs <c>koine lsp</c> with), scrapes the
/// endpoint it announces on stderr, and drives it with the official MCP client over HTTP. This
/// proves <c>koine mcp --http</c> stands up a working server — argument wiring included — and that
/// the tools resolve from Koine.Mcp even though the entry assembly is Koine.Cli.
/// </summary>
public sealed class CliMcpTests
{
    [Fact]
    public async Task Cli_mcp_http_serves_the_tools_over_http()
    {
        // The CLI dll is copied next to the test assembly via the project reference; run it with
        // `dotnet <dll>` so the test is independent of build configuration and OS.
        var cliDll = Path.Combine(AppContext.BaseDirectory, "Koine.Cli.dll");
        Assert.True(File.Exists(cliDll), $"Koine.Cli.dll not found next to the test assembly: {cliDll}");

        var psi = new ProcessStartInfo("dotnet")
        {
            ArgumentList = { cliDll, "mcp", "--http", "--port", "0" },
            RedirectStandardError = true,
            RedirectStandardOutput = true,
            UseShellExecute = false,
        };
        psi.Environment["DOTNET_NOLOGO"] = "1";
        psi.Environment["DOTNET_CLI_TELEMETRY_OPTOUT"] = "1";

        using var proc = Process.Start(psi)!;
        try
        {
            var url = await ReadAnnouncedEndpointAsync(proc, TimeSpan.FromSeconds(60));

            var transport = new HttpClientTransport(new HttpClientTransportOptions
            {
                Name = "Koine",
                Endpoint = new Uri(url),
                TransportMode = HttpTransportMode.StreamableHttp,
            });
            await using var client = await McpClient.CreateAsync(transport, cancellationToken: CancellationToken.None);

            var names = (await client.ListToolsAsync()).Select(t => t.Name).ToHashSet();
            Assert.Contains("koine_validate", names);
            Assert.Contains("koine_compile", names);
            Assert.Contains("koine_format", names);
            Assert.Contains("koine_reference", names);
            Assert.Contains("koine_examples", names);
        }
        finally
        {
            if (!proc.HasExited)
            {
                proc.Kill(entireProcessTree: true);
            }
        }
    }

    /// <summary>
    /// Reads the child's stderr until it prints the <c>[koine-mcp] http://HOST:PORT/mcp</c> line
    /// (the launcher contract HttpHost guarantees), returning the URL. Throws on timeout/EOF first.
    /// </summary>
    private static async Task<string> ReadAnnouncedEndpointAsync(Process proc, TimeSpan timeout)
    {
        using var cts = new CancellationTokenSource(timeout);
        string? line;
        while ((line = await proc.StandardError.ReadLineAsync(cts.Token)) is not null)
        {
            if (!line.Contains(HttpHost.EndpointLogPrefix, StringComparison.Ordinal))
            {
                continue;
            }

            var idx = line.IndexOf("http://", StringComparison.Ordinal);
            if (idx >= 0)
            {
                return line[idx..].Trim();
            }
        }

        throw new InvalidOperationException("the CLI did not announce an MCP endpoint on stderr before exiting");
    }
}
