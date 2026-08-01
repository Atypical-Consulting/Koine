using System.Diagnostics;
using System.Globalization;

namespace Koine.Execution;

/// <summary>
/// Plans the OS-level confinement of one scenario child (issue #1759), on top of ADR 0011's process
/// isolation and wall-clock deadline.
///
/// <para><b>How confinement is applied at all.</b> .NET gives no pre-exec hook — no
/// <c>posix_spawn</c> attribute bag, no place to call <c>setrlimit</c> or <c>sandbox_init</c> between
/// fork and exec — so on Unix the only way in is to make the child BE the confining program and have it
/// <c>exec</c> into the real command: the process identity, the pipes and the PID all survive, so the
/// host's <c>Kill(entireProcessTree: true)</c> and its stdio protocol are untouched. On Windows the
/// mechanism is the reverse shape — a Job Object attached to the process after it starts (see
/// <see cref="WindowsJobObject"/>).</para>
///
/// <para><b>Availability is probed, not assumed.</b> Every wrapper is tried once per host process against
/// a trivial command and cached; a mechanism that is missing, refused by the kernel, or rejects its own
/// profile is dropped BEFORE it can turn a working scenario into a failed one. That is the issue's hard
/// rule: never fail a scenario because confinement is unavailable — degrade, and say so.</para>
/// </summary>
internal static class ScenarioSandbox
{
    /// <summary>The runtime's own managed-heap hard limit — a hexadecimal byte count. The one memory
    /// ceiling that works identically on every platform, because the child's own runtime enforces it;
    /// it also lands exactly where a runaway allocation in emitted code lands.</summary>
    internal const string HeapHardLimitVariable = "DOTNET_GCHeapHardLimit";

    /// <summary>How long an availability probe gets before it is treated as unavailable.</summary>
    private static readonly TimeSpan ProbeTimeout = TimeSpan.FromSeconds(10);

    private static readonly Lazy<bool> ShellAvailable = new(() => !OperatingSystem.IsWindows() && File.Exists(ShellPath));

    private const string ShellPath = "/bin/sh";

    /// <summary>
    /// The confinement to run <paramref name="fileName"/> <paramref name="arguments"/> under, for a child
    /// whose working directory is <paramref name="runDirectory"/>. Never throws and never returns
    /// <c>null</c>: the worst case is the caller's own command back, with the reason in
    /// <see cref="ScenarioConfinement.Degradations"/>.
    /// </summary>
    public static ScenarioConfinement Plan(
        string fileName,
        IReadOnlyList<string> arguments,
        string runDirectory,
        ScenarioSandboxOptions options)
    {
        var degradations = new List<string>();
        var environment = new Dictionary<string, string>(StringComparer.Ordinal);
        string file = fileName;
        List<string> args = [.. arguments];

        try
        {
            if (options.MemoryLimitBytes is { } bytes and > 0)
            {
                // Hexadecimal, no 0x prefix — that is the format the runtime's config reader expects.
                environment[HeapHardLimitVariable] = bytes.ToString("X", CultureInfo.InvariantCulture);
            }

            if (!OperatingSystem.IsWindows())
            {
                PlanUnix(ref file, args, options, degradations);
            }
            else if (options.MemoryLimitBytes is null && options.CpuLimit is null)
            {
                // Nothing for the Job Object to carry; Attach will not create one either.
            }
        }
        catch (Exception ex)
        {
            // Planning is pure bookkeeping, so this should not happen — but a plan that throws would fail
            // a scenario for a reason that has nothing to do with the model, which the contract forbids.
            degradations.Add("The sandbox could not arrange OS-level confinement (" + ex.Message
                + "); the run kept its process isolation and wall-clock deadline.");
            return new ScenarioConfinement(fileName, arguments, environment, options, degradations);
        }

        return new ScenarioConfinement(file, args, environment, options, degradations);
    }

    /// <summary>
    /// Wraps the command in <c>/bin/sh</c> so <c>ulimit</c> can lower the child's <c>RLIMIT_CPU</c> before
    /// it <c>exec</c>s into the real command — the processor-time ceiling every Unix has, inherited by
    /// anything the child goes on to start.
    ///
    /// <para>Deliberately NOT <c>ulimit -v</c>: <c>RLIMIT_AS</c> caps reserved ADDRESS SPACE, and the .NET
    /// GC reserves far more than it commits, so a limit generous enough for the runtime to start is far
    /// too loose to be a memory cap and a limit tight enough to be one stops the runtime from starting.
    /// The heap hard limit in <see cref="Plan"/> is the cap that actually works here.</para>
    /// </summary>
    private static void PlanUnix(
        ref string file, List<string> args, ScenarioSandboxOptions options, List<string> degradations)
    {
        if (options.CpuLimit is not { } cpu || cpu <= TimeSpan.Zero)
        {
            return;
        }

        if (!ShellAvailable.Value)
        {
            degradations.Add("The sandbox's processor-time ceiling was not applied because " + ShellPath
                + " is unavailable; the run kept its wall-clock deadline.");
            return;
        }

        long seconds = Math.Max(1, (long)Math.Ceiling(cpu.TotalSeconds));

        // `exec "$0" "$@"` replaces the shell rather than forking under it, so the PID the host holds IS
        // the command's — the process-tree kill, the exit code and the three pipes all keep working. The
        // `ulimit` failure is swallowed: a shell that cannot lower the limit must still run the scenario.
        string script = "ulimit -t " + seconds.ToString(CultureInfo.InvariantCulture)
            + " 2>/dev/null || true; exec \"$0\" \"$@\"";

        List<string> wrapped = ["-c", script, file, .. args];
        args.Clear();
        args.AddRange(wrapped);
        file = ShellPath;
    }

    /// <summary>
    /// Runs <paramref name="fileName"/> <paramref name="arguments"/> once, with no stdio and a short
    /// deadline, and reports whether it succeeded — the availability test for a confinement wrapper. A
    /// wrapper that cannot run a trivial command here would not have run the scenario either.
    /// </summary>
    internal static bool Probe(string fileName, IReadOnlyList<string> arguments)
    {
        try
        {
            var startInfo = new ProcessStartInfo
            {
                FileName = fileName,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            foreach (string argument in arguments)
            {
                startInfo.ArgumentList.Add(argument);
            }

            using Process? probe = Process.Start(startInfo);
            if (probe is null)
            {
                return false;
            }

            // Drain both pipes so a probe that prints something cannot wedge on a full buffer.
            Task<string> output = probe.StandardOutput.ReadToEndAsync();
            Task<string> error = probe.StandardError.ReadToEndAsync();
            if (!probe.WaitForExit((int)ProbeTimeout.TotalMilliseconds))
            {
                try
                {
                    probe.Kill(entireProcessTree: true);
                }
                catch (Exception)
                {
                    // Already gone; nothing to stop.
                }

                return false;
            }

            try
            {
                Task.WaitAll([output, error], ProbeTimeout);
            }
            catch (Exception)
            {
                // A faulted read says nothing about the exit code, which is what the probe is asking about.
            }

            return probe.ExitCode == 0;
        }
        catch (Exception)
        {
            return false;
        }
    }

    /// <summary>
    /// The note a CHILD writes when it dies of the heap hard limit — read from its own environment, so
    /// the number in the message is the ceiling that was actually in force rather than a default the
    /// host happened to compile in. <c>null</c> when the child is running without a heap ceiling.
    /// </summary>
    public static string? HeapCeilingNote()
    {
        string? configured = System.Environment.GetEnvironmentVariable(HeapHardLimitVariable);
        if (string.IsNullOrWhiteSpace(configured)
            || !long.TryParse(configured, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out long bytes)
            || bytes <= 0)
        {
            return null;
        }

        return "The scenario exhausted the sandbox's memory ceiling of " + ScenarioConfinement.Mebibytes(bytes)
            + " and was stopped. That is a resource ceiling, not the wall-clock deadline: the emitted code "
            + "allocated without bound rather than merely running slowly.";
    }
}
