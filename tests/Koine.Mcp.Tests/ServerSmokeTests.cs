using Koine.Mcp.Tools;
using ModelContextProtocol.Client;
using ModelContextProtocol.Protocol;

namespace Koine.Mcp.Tests;

/// <summary>
/// End-to-end smoke test: launches the real Koine.Mcp server as a child process and drives it with
/// the official MCP client over stdio (the same path an agent uses), exercising the initialize
/// handshake, tools/list, and a tools/call round-trip.
/// </summary>
public sealed class ServerSmokeTests
{
    private static StdioClientTransport ServerTransport()
    {
        // The Koine.Mcp.dll is copied next to the test assembly via the project reference; run it
        // with `dotnet <dll>` so the test is independent of build configuration and OS.
        var dll = typeof(ExamplesTool).Assembly.Location;
        return new StdioClientTransport(new StdioClientTransportOptions
        {
            Name = "Koine",
            Command = "dotnet",
            Arguments = [dll],
            ShutdownTimeout = TimeSpan.FromSeconds(10),
        });
    }

    [Fact]
    public async Task Server_lists_all_koine_tools()
    {
        await using var client = await McpClient.CreateAsync(ServerTransport());

        var tools = await client.ListToolsAsync();
        var names = tools.Select(t => t.Name).ToHashSet();

        Assert.Contains("koine_validate", names);
        Assert.Contains("koine_compile", names);
        Assert.Contains("koine_format", names);
        Assert.Contains("koine_reference", names);
        Assert.Contains("koine_examples", names);
    }

    [Fact]
    public async Task Server_answers_a_tool_call_over_stdio()
    {
        await using var client = await McpClient.CreateAsync(ServerTransport());

        var result = await client.CallToolAsync(
            "koine_examples",
            new Dictionary<string, object?> { ["name"] = "billing" },
            cancellationToken: CancellationToken.None);

        Assert.False(result.IsError ?? false);
        var text = result.Content.OfType<TextContentBlock>().First().Text;
        Assert.Contains("context Billing", text);
    }

    [Fact]
    public async Task Server_validates_a_file_list_argument_over_stdio()
    {
        await using var client = await McpClient.CreateAsync(ServerTransport());

        // Exercises binding of the KoineFile[] argument across the wire (the core agent path).
        var result = await client.CallToolAsync(
            "koine_validate",
            new Dictionary<string, object?>
            {
                ["files"] = new[]
                {
                    new Dictionary<string, object?>
                    {
                        ["path"] = "ok.koi",
                        ["source"] = "context C { enum Color { Red, Green } }",
                    },
                },
            },
            cancellationToken: CancellationToken.None);

        Assert.False(result.IsError ?? false);
        var text = result.Content.OfType<TextContentBlock>().First().Text;
        Assert.Contains("\"ok\"", text, StringComparison.OrdinalIgnoreCase);
    }
}
