using System.Globalization;
using System.Net;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Koine.Mcp;

/// <summary>
/// Hosts the Koine MCP server over <b>HTTP</b> (the SDK's Streamable HTTP / SSE transport) so any
/// MCP client can reach the tools by URL instead of the stdio command/DLL ceremony — e.g. an
/// LM Studio <c>mcp.json</c> collapses to
/// <c>{ "mcpServers": { "koine": { "url": "http://127.0.0.1:PORT/mcp" } } }</c>.
///
/// <para>The very same <c>[McpServerToolType]</c> classes are registered, unchanged, via
/// <c>WithToolsFromAssembly</c>/<c>WithResourcesFromAssembly</c> (over <b>this</b> assembly, so the
/// host works whether launched as <c>koine-mcp --http</c> or hosted by the CLI as
/// <c>koine mcp --http</c>); only the transport differs from <see cref="StdioHost"/>.</para>
///
/// <para>Binds to <b>loopback only</b> by default, which keeps the surface local. On a loopback bind
/// the server defends itself against DNS-rebinding and drive-by cross-origin attacks: CORS only
/// allows loopback origins and a Host-header guard rejects requests whose <c>Host</c> resolves to a
/// non-loopback name. Binding to a non-loopback/wildcard host is an explicit opt-in into remote
/// exposure — CORS opens up but a stderr warning is printed, since the server is unauthenticated. The
/// resolved endpoint is printed to <b>stderr</b> as <c>[koine-mcp] http://HOST:PORT/mcp</c> so a
/// launcher (Koine Studio's Tauri shell) can scrape it, and stdout is left clean to match the stdio
/// host.</para>
/// </summary>
public static class HttpHost
{
    /// <summary>The MCP endpoint path mapped by <c>app.MapMcp</c> (the SDK's convention).</summary>
    internal const string McpPath = "/mcp";

    /// <summary>Default bind address: loopback, so the server is reachable only from this machine.</summary>
    internal const string DefaultHost = "127.0.0.1";

    /// <summary>The prefix of the stderr line that announces the bound endpoint, for launchers to scrape.</summary>
    internal const string EndpointLogPrefix = "[koine-mcp] ";

    /// <summary>
    /// Maximum accepted request body size (16 MiB) — generous for <c>.koi</c> text, but a hard cap so
    /// a hostile or buggy client can't exhaust memory by streaming an unbounded body.
    /// </summary>
    internal const long MaxRequestBodyBytes = 16L * 1024 * 1024;

    /// <summary>
    /// Builds the host, binds it (default <c>127.0.0.1:0</c> — an OS-assigned port), announces the
    /// resolved <c>/mcp</c> URL on stderr, and serves until shutdown (Ctrl+C / SIGTERM).
    /// </summary>
    public static async Task RunAsync(string[] args)
    {
        var (host, port) = ParseEndpoint(args);
        await RunAsync(host, port);
    }

    /// <summary>
    /// Builds the host bound to <paramref name="host"/>:<paramref name="port"/>, announces the
    /// resolved <c>/mcp</c> URL on stderr, and serves until shutdown (Ctrl+C / SIGTERM). Rejects an
    /// out-of-range port and warns (but proceeds) on a non-loopback bind.
    /// </summary>
    internal static async Task RunAsync(string host, int port)
    {
        if (!IsValidPort(port))
        {
            Console.Error.WriteLine(EndpointLogPrefix + $"error: port must be 0-65535 (got {port})");
            return;
        }

        if (!IsLoopbackHost(host))
        {
            Console.Error.WriteLine(EndpointLogPrefix
                + "warning: binding to a non-loopback address exposes the unauthenticated MCP server to the network");
        }

        var app = Build(host, port);

        await app.StartAsync();
        // Print AFTER Start so a `--port 0` (auto) bind reports the real, resolved port.
        Console.Error.WriteLine(EndpointLogPrefix + McpUrl(app));
        await app.WaitForShutdownAsync();
    }

    /// <summary>
    /// Builds (but does not start) the ASP.NET Core host that serves the MCP tools over HTTP, bound
    /// to <paramref name="host"/>:<paramref name="port"/>. Exposed for the transport handshake test.
    /// </summary>
    internal static WebApplication Build(string host, int port)
    {
        // No args are forwarded to CreateBuilder on purpose: our own --http/--port/--host flags are
        // not ASP.NET Core configuration keys, and the command-line config provider rejects a lone
        // switch like "--http". We parse the endpoint ourselves (see ParseEndpoint).
        var builder = WebApplication.CreateBuilder();

        // Parity with the stdio host: route all console logs to stderr so stdout stays clean.
        builder.Logging.AddConsole(options =>
            options.LogToStandardErrorThreshold = LogLevel.Trace);

        // Cap the request body so a hostile/buggy client can't exhaust memory with an unbounded body.
        builder.WebHost.ConfigureKestrel(o => o.Limits.MaxRequestBodySize = MaxRequestBodyBytes);

        var mcpAssembly = typeof(HttpHost).Assembly;
        builder.Services
            .AddMcpServer()
            .WithHttpTransport()
            .WithToolsFromAssembly(mcpAssembly)
            .WithResourcesFromAssembly(mcpAssembly);

        // A loopback bind is only reachable from this machine, but a website the user visits can still
        // drive it from their browser (a DNS-rebinding / drive-by cross-origin attack). So on a
        // loopback bind, restrict CORS to loopback origins (no-Origin, non-browser clients are
        // unaffected) and add a Host-header guard below. A non-loopback/wildcard bind is an explicit
        // opt-in into remote use, so we honour the operator's intent and allow any origin.
        var loopbackOnly = IsLoopbackHost(host);
        builder.Services.AddCors(options => options.AddDefaultPolicy(policy =>
        {
            if (loopbackOnly)
            {
                policy.SetIsOriginAllowed(IsLoopbackOrigin);
            }
            else
            {
                policy.AllowAnyOrigin();
            }

            policy
                .AllowAnyHeader()
                .AllowAnyMethod()
                .WithExposedHeaders("Mcp-Session-Id");
        }));

        var app = builder.Build();

        // Override any ambient ASPNETCORE_URLS so the bind is exactly what was requested.
        app.Urls.Clear();
        app.Urls.Add($"http://{host}:{port}");

        app.UseCors();

        // Anti-DNS-rebinding guard: on a loopback bind, reject any request whose Host header doesn't
        // resolve to loopback. ctx.Request.Host.Host strips the port. Requests from the MCP client
        // (Host=127.0.0.1) pass; a rebound attacker domain (Host=evil.example) is refused.
        if (loopbackOnly)
        {
            app.Use(async (ctx, next) =>
            {
                if (!IsLoopbackHost(ctx.Request.Host.Host))
                {
                    ctx.Response.StatusCode = 403;
                    return;
                }

                await next();
            });
        }

        app.MapMcp(McpPath);
        return app;
    }

    /// <summary>True when <paramref name="port"/> is a bindable TCP port (0 = OS-assigned, else 1-65535).</summary>
    internal static bool IsValidPort(int port) => port is >= 0 and <= 65535;

    /// <summary>
    /// True when <paramref name="host"/> names the loopback interface: the DNS name <c>localhost</c>,
    /// or any address in the IPv4 loopback block <c>127.0.0.0/8</c> (e.g. <c>127.0.0.1</c>,
    /// <c>127.0.0.2</c>), or IPv6 <c>::1</c> (with or without brackets). Classifying by the actual IP
    /// — via <see cref="IPAddress.IsLoopback"/> — rather than a literal allowlist means the security
    /// defences can't fail <i>open</i> on a non-<c>.1</c> loopback bind. A wildcard bind
    /// (<c>0.0.0.0</c>, <c>::</c>) or any routable address is <b>not</b> loopback.
    /// </summary>
    internal static bool IsLoopbackHost(string host)
    {
        if (string.IsNullOrWhiteSpace(host))
        {
            return false;
        }

        var normalized = host.Trim().Trim('[', ']');
        return normalized.Equals("localhost", StringComparison.OrdinalIgnoreCase)
            || (IPAddress.TryParse(normalized, out var ip) && IPAddress.IsLoopback(ip));
    }

    /// <summary>
    /// True when <paramref name="origin"/> is a well-formed URL whose host is loopback (see
    /// <see cref="IsLoopbackHost"/>). A malformed origin is rejected.
    /// </summary>
    internal static bool IsLoopbackOrigin(string origin) =>
        Uri.TryCreate(origin, UriKind.Absolute, out var uri) && IsLoopbackHost(uri.Host);

    /// <summary>The resolved <c>http://HOST:PORT/mcp</c> URL of a started host (real port if bound with 0).</summary>
    internal static string McpUrl(WebApplication app) => BaseUrl(app).TrimEnd('/') + McpPath;

    /// <summary>
    /// The base address a started host actually bound to, read from the server's address feature so a
    /// <c>--port 0</c> (auto) bind reports the OS-assigned port rather than <c>:0</c>.
    /// </summary>
    internal static string BaseUrl(WebApplication app)
    {
        var addresses = app.Services.GetRequiredService<IServer>().Features
            .Get<IServerAddressesFeature>()?.Addresses;
        return addresses?.FirstOrDefault() ?? app.Urls.First();
    }

    /// <summary>
    /// Parses <c>--host H</c> (default <see cref="DefaultHost"/>) and <c>--port N</c> (default 0 =
    /// OS-assigned) out of the argument vector, ignoring everything else (e.g. the <c>--http</c>
    /// selector itself). An unparseable or missing <c>--port</c> value leaves the default.
    /// </summary>
    internal static (string Host, int Port) ParseEndpoint(string[] args)
    {
        var host = DefaultHost;
        var port = 0;
        for (var i = 0; i < args.Length; i++)
        {
            switch (args[i])
            {
                case "--host" when i + 1 < args.Length:
                    host = args[++i];
                    break;
                case "--port" when i + 1 < args.Length
                    && int.TryParse(args[i + 1], NumberStyles.Integer, CultureInfo.InvariantCulture, out var p):
                    port = p;
                    i++;
                    break;
            }
        }

        return (host, port);
    }
}
