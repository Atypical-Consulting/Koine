using System.Diagnostics;

namespace Koine.Mcp.Tests;

/// <summary>
/// Covers the standalone <c>koine-mcp</c> entry point's process exit code, the surface that a
/// process manager, agent harness, or the Koine Studio launcher gates on. The in-process CLI
/// (<c>koine mcp --http</c>) already exits <c>1</c> on an out-of-range <c>--port</c> (proved by
/// <see cref="HttpHostSecurityTests"/> over <see cref="HttpHost.IsValidPort"/> and the CLI's own
/// pre-check); this proves the packaged tool matches it instead of silently exiting <c>0</c>.
/// </summary>
public sealed class StandaloneMcpExitCodeTests
{
    [Fact]
    public async Task Standalone_http_exits_1_on_an_out_of_range_port()
    {
        // The Koine.Mcp.dll is copied next to the test assembly via the project reference; run it with
        // `dotnet <dll>` so the test is independent of build configuration and OS (as ServerSmokeTests).
        var dll = typeof(HttpHost).Assembly.Location;
        File.Exists(dll).ShouldBeTrue($"Koine.Mcp.dll not found next to the test assembly: {dll}");

        var psi = new ProcessStartInfo("dotnet")
        {
            ArgumentList = { dll, "--http", "--port", "99999" },
            RedirectStandardError = true,
            RedirectStandardOutput = true,
            UseShellExecute = false,
        };
        psi.Environment["DOTNET_NOLOGO"] = "1";
        psi.Environment["DOTNET_CLI_TELEMETRY_OPTOUT"] = "1";

        using var proc = Process.Start(psi)!;
        try
        {
            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(60));
            var stderr = await proc.StandardError.ReadToEndAsync(cts.Token);
            await proc.WaitForExitAsync(cts.Token);

            proc.ExitCode.ShouldBe(1, $"standalone koine-mcp must signal failure on an invalid port; stderr was: {stderr}");
            stderr.ShouldContain("port must be 0-65535 (got 99999)");
        }
        finally
        {
            if (!proc.HasExited)
            {
                proc.Kill(entireProcessTree: true);
            }
        }
    }

    [Fact]
    public async Task RunAsync_returns_1_for_an_out_of_range_port()
    {
        // The host reports the failure status that Program.Main propagates as the exit code, mirroring
        // McpCommand's `return 1`. Exercised in-process so it stays fast and deterministic.
        var status = await HttpHost.RunAsync("127.0.0.1", 99999);
        status.ShouldBe(1);
    }
}
