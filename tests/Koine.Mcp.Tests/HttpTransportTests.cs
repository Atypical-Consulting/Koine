using Koine.Mcp;
using Microsoft.AspNetCore.Builder;
using ModelContextProtocol.Client;
using ModelContextProtocol.Protocol;

namespace Koine.Mcp.Tests;

/// <summary>
/// End-to-end coverage of the HTTP (Streamable HTTP) transport: boots the real <see cref="HttpHost"/>
/// on an OS-assigned loopback port and drives it with the official MCP client over HTTP — the same
/// path an MCP client like LM Studio uses — exercising the initialize handshake, tools/list, and
/// tools/call round-trips on a known-good and a known-bad model. Mirrors the stdio coverage in
/// <see cref="ServerSmokeTests"/>, proving the tools are reused verbatim across both transports.
/// </summary>
public sealed class HttpTransportTests : IAsyncLifetime
{
    private WebApplication _app = null!;
    private McpClient _client = null!;

    public async Task InitializeAsync()
    {
        // --port 0 ⇒ the OS assigns a free loopback port, so the test never collides with a
        // long-running server or another test run.
        _app = HttpHost.Build("127.0.0.1", 0);
        await _app.StartAsync();

        var transport = new HttpClientTransport(new HttpClientTransportOptions
        {
            Name = "Koine",
            Endpoint = new Uri(HttpHost.McpUrl(_app)),
            TransportMode = HttpTransportMode.StreamableHttp,
        });
        _client = await McpClient.CreateAsync(transport, cancellationToken: CancellationToken.None);
    }

    public async Task DisposeAsync()
    {
        await _client.DisposeAsync();
        await _app.DisposeAsync();
    }

    [Fact]
    public async Task Http_server_lists_all_koine_tools()
    {
        var tools = await _client.ListToolsAsync();
        var names = tools.Select(t => t.Name).ToHashSet();

        Assert.Contains("koine_validate", names);
        Assert.Contains("koine_compile", names);
        Assert.Contains("koine_format", names);
        Assert.Contains("koine_reference", names);
        Assert.Contains("koine_examples", names);
    }

    [Fact]
    public async Task Http_validate_accepts_a_clean_model_over_http()
    {
        var result = await _client.CallToolAsync(
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

    [Fact]
    public async Task Http_validate_reports_an_unknown_type_on_a_bad_model()
    {
        var result = await _client.CallToolAsync(
            "koine_validate",
            new Dictionary<string, object?>
            {
                ["files"] = new[]
                {
                    new Dictionary<string, object?>
                    {
                        ["path"] = "bad.koi",
                        ["source"] = "context C { value V { x: Nope } }",
                    },
                },
            },
            cancellationToken: CancellationToken.None);

        // The tool call itself succeeds; the diagnostics it returns describe the model's error.
        // The diagnostic reads "unknown type 'Nope'" — assert the escaping-agnostic parts (the
        // serializer renders the apostrophes around the type name as ' on the wire).
        Assert.False(result.IsError ?? false);
        var text = result.Content.OfType<TextContentBlock>().First().Text;
        Assert.Contains("\"ok\":false", text);
        Assert.Contains("unknown type", text);
        Assert.Contains("Nope", text);
    }
}
