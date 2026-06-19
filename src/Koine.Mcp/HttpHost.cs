using System.Globalization;
using Microsoft.AspNetCore.Builder;
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
/// <para>Binds to <b>loopback only</b> by default, which keeps the surface local; CORS is permissive
/// so browser-based MCP clients can connect. The resolved endpoint is printed to <b>stderr</b> as
/// <c>[koine-mcp] http://HOST:PORT/mcp</c> so a launcher (Koine Studio's Tauri shell) can scrape it,
/// and stdout is left clean to match the stdio host.</para>
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
    /// Builds the host, binds it (default <c>127.0.0.1:0</c> — an OS-assigned port), announces the
    /// resolved <c>/mcp</c> URL on stderr, and serves until shutdown (Ctrl+C / SIGTERM).
    /// </summary>
    public static async Task RunAsync(string[] args)
    {
        var (host, port) = ParseEndpoint(args);
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

        var mcpAssembly = typeof(HttpHost).Assembly;
        builder.Services
            .AddMcpServer()
            .WithHttpTransport()
            .WithToolsFromAssembly(mcpAssembly)
            .WithResourcesFromAssembly(mcpAssembly);

        // The bind is loopback-only, so exposure is local; allow any local MCP client (including
        // browser-based ones) to call it, and expose the Streamable-HTTP session header so a browser
        // client can read it back across the CORS boundary.
        builder.Services.AddCors(options => options.AddDefaultPolicy(policy => policy
            .AllowAnyOrigin()
            .AllowAnyHeader()
            .AllowAnyMethod()
            .WithExposedHeaders("Mcp-Session-Id")));

        var app = builder.Build();

        // Override any ambient ASPNETCORE_URLS so the bind is exactly what was requested.
        app.Urls.Clear();
        app.Urls.Add($"http://{host}:{port}");

        app.UseCors();
        app.MapMcp(McpPath);
        return app;
    }

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
