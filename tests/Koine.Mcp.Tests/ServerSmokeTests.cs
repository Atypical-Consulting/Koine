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
        await using var client = await McpClient.CreateAsync(ServerTransport(), cancellationToken: TestContext.Current.CancellationToken);

        var tools = await client.ListToolsAsync(cancellationToken: TestContext.Current.CancellationToken);
        var names = tools.Select(t => t.Name).ToHashSet();

        names.ShouldContain("koine_validate");
        names.ShouldContain("koine_compile");
        names.ShouldContain("koine_format");
        names.ShouldContain("koine_reference");
        names.ShouldContain("koine_examples");
        names.ShouldContain("koine_coverage");
    }

    [Fact]
    public async Task Server_answers_a_tool_call_over_stdio()
    {
        await using var client = await McpClient.CreateAsync(ServerTransport(), cancellationToken: TestContext.Current.CancellationToken);

        var result = await client.CallToolAsync(
            "koine_examples",
            new Dictionary<string, object?> { ["name"] = "billing" },
            cancellationToken: CancellationToken.None);

        (result.IsError ?? false).ShouldBeFalse();
        var text = result.Content.OfType<TextContentBlock>().First().Text;
        text.ShouldContain("context Billing");
    }

    [Fact]
    public async Task Server_validates_a_file_list_argument_over_stdio()
    {
        await using var client = await McpClient.CreateAsync(ServerTransport(), cancellationToken: TestContext.Current.CancellationToken);

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

        (result.IsError ?? false).ShouldBeFalse();
        var text = result.Content.OfType<TextContentBlock>().First().Text;
        text.ShouldContain("\"ok\"");
    }
}
