using System.Net;
using Koine.Mcp;
using Microsoft.AspNetCore.Builder;

namespace Koine.Mcp.Tests;

/// <summary>
/// Unit coverage of <see cref="HttpHost"/>'s pure security helpers — the port-range check, the
/// loopback-host classifier, and the loopback-origin classifier — that gate the HTTP transport's
/// DNS-rebinding / cross-origin defences, plus an end-to-end check that a forged <c>Host</c> header
/// is refused. The happy-path transport behaviour lives in <see cref="HttpTransportTests"/> and
/// <see cref="CliMcpTests"/>; here we pin the decision logic.
/// </summary>
public sealed class HttpHostSecurityTests
{
    [Fact]
    public async Task Loopback_bind_refuses_a_forged_non_loopback_Host_header()
    {
        // Boot a real loopback host and send a request carrying a rebound attacker domain in Host.
        // The anti-DNS-rebinding guard must short-circuit it with 403 before it reaches the MCP
        // endpoint — the core of finding 1.
        var app = HttpHost.Build("127.0.0.1", 0);
        await app.StartAsync(TestContext.Current.CancellationToken);
        try
        {
            var endpoint = HttpHost.McpUrl(app); // http://127.0.0.1:<port>/mcp
            using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(10) };

            using var forged = new HttpRequestMessage(HttpMethod.Get, endpoint);
            forged.Headers.Host = "evil.example";
            var response = await http.SendAsync(forged, TestContext.Current.CancellationToken);

            response.StatusCode.ShouldBe(HttpStatusCode.Forbidden);
        }
        finally
        {
            await app.DisposeAsync();
        }
    }

    [Theory]
    [InlineData(0, true)]
    [InlineData(65535, true)]
    [InlineData(8080, true)]
    [InlineData(-1, false)]
    [InlineData(65536, false)]
    [InlineData(99999, false)]
    public void IsValidPort_accepts_only_the_0_to_65535_range(int port, bool expected)
    {
        HttpHost.IsValidPort(port).ShouldBe(expected);
    }

    [Theory]
    [InlineData("127.0.0.1", true)]
    [InlineData("127.0.0.2", true)]   // the whole 127.0.0.0/8 block is loopback, not just .1
    [InlineData("127.1.2.3", true)]
    [InlineData("localhost", true)]
    [InlineData("LOCALHOST", true)]
    [InlineData("::1", true)]
    [InlineData("[::1]", true)]
    [InlineData("0.0.0.0", false)]
    [InlineData("::", false)]
    [InlineData("192.168.1.5", false)]
    [InlineData("10.0.0.1", false)]
    [InlineData("127.0.0.1.evil.com", false)]
    [InlineData("", false)]
    public void IsLoopbackHost_recognises_loopback_names_only(string host, bool expected)
    {
        HttpHost.IsLoopbackHost(host).ShouldBe(expected);
    }

    [Theory]
    [InlineData("http://127.0.0.1:5000", true)]
    [InlineData("http://127.0.0.2:5000", true)]
    [InlineData("http://localhost", true)]
    [InlineData("http://[::1]:7000", true)]
    [InlineData("https://evil.com", false)]
    [InlineData("http://192.168.1.5:5000", false)]
    [InlineData("http://127.0.0.1.evil.com", false)]
    [InlineData("garbage", false)]
    public void IsLoopbackOrigin_allows_only_well_formed_loopback_origins(string origin, bool expected)
    {
        HttpHost.IsLoopbackOrigin(origin).ShouldBe(expected);
    }
}
