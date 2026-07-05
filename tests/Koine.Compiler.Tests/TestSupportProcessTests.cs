namespace Koine.Compiler.Tests;

/// <summary>
/// Regression coverage for <see cref="TestSupport.RunProcess"/>'s stdout/stderr draining. That helper
/// backs every external-toolchain conformance check (mypy, Python, phpstan/<c>php&#160;-l</c>, cargo,
/// tsc/node), so a pipe-buffer deadlock there would hang the whole test run rather than failing cleanly.
/// See issue #1034.
/// </summary>
public sealed class TestSupportProcessTests
{
    /// <summary>
    /// Drives a child that writes well past the OS pipe buffer (~64&#160;KB) to <em>both</em> stdout and
    /// stderr, interleaved, then exits. Under the old read-stdout-to-EOF-then-stderr sequencing the child
    /// blocks on a full stderr pipe while the parent blocks on the unfinished stdout read — a permanent
    /// deadlock. With concurrent draining the call returns promptly with both streams captured in full.
    /// </summary>
    [Fact]
    public async Task RunProcess_DrainsLargeStdoutAndStderr_WithoutDeadlocking()
    {
        // POSIX-sh driver; the conformance harness this guards only runs on Unix (CI is ubuntu, dev is
        // macOS). Skip elsewhere rather than assert a Windows-shell equivalent — the code path is shared.
        if (OperatingSystem.IsWindows())
        {
            Assert.Skip("Deadlock driver uses /bin/sh; RunProcess itself is platform-agnostic.");
        }

        // ~40 bytes/line => ~160 KB per stream, comfortably past the ~64 KB pipe buffer that triggers the
        // deadlock when the second-read stream (stderr) fills before the first (stdout) reaches EOF.
        const int lines = 4000;
        string script =
            $"i=0; while [ $i -lt {lines} ]; do "
            + "echo \"stdout padding line $i ................................\"; "
            + "echo \"stderr padding line $i ................................\" 1>&2; "
            + "i=$((i + 1)); done";

        // Run on a worker with a bounded wait so a *regression* fails the test in 30s (TimeoutException)
        // instead of hanging the whole CI job the way the original bug would.
        TestSupport.ProcessRun? result = null;
        var worker = Task.Run(() => result = TestSupport.RunProcess("/bin/sh", ["-c", script]));

        try
        {
            await worker.WaitAsync(TimeSpan.FromSeconds(30), TestContext.Current.CancellationToken);
        }
        catch (TimeoutException)
        {
            Assert.Fail("RunProcess did not return within 30s — the stdout/stderr pipe-buffer deadlock regressed.");
        }

        result.ShouldNotBeNull();
        TestSupport.ProcessRun run = result.Value;
        run.ExitCode.ShouldBe(0);

        // Both streams were captured in full: the last line of each is present and each exceeds the pipe
        // buffer — proving neither read starved while the other drained.
        run.StdOut.ShouldContain($"stdout padding line {lines - 1} ");
        run.StdErr.ShouldContain($"stderr padding line {lines - 1} ");
        run.StdOut.Length.ShouldBeGreaterThan(64 * 1024);
        run.StdErr.Length.ShouldBeGreaterThan(64 * 1024);
    }
}
