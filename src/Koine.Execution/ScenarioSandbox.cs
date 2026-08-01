using System.Diagnostics;
using System.Globalization;
using System.Text;

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

    /// <summary>How long an availability probe gets before it is treated as unavailable. Short on
    /// purpose: the probe launches a no-op program, so anything beyond a couple of seconds is a wedged
    /// mechanism rather than a slow one — and this time is spent BEFORE the child starts, outside the
    /// caller's own budget (see <see cref="MaxProbeCost"/>).</summary>
    private static readonly TimeSpan ProbeTimeout = TimeSpan.FromSeconds(2);

    /// <summary>How many probes one <see cref="Plan"/> can run in the worst case: the filesystem/network
    /// wrapper for this platform, and the shell for the processor-time ceiling.
    ///
    /// <para>Unchanged by the Linux write confinement added in issue #1781: <see cref="LandlockAvailable"/>
    /// asks the KERNEL directly (a <c>landlock_create_ruleset</c> version query, microseconds, no child)
    /// and then only checks that the launcher verb resolves to a file. Nothing is spawned, so the published
    /// latency promise below does not move — deliberately, since a mechanism that made every first Linux
    /// run a second slower would be paid by every host, including the ones it cannot help.</para></summary>
    private const int MaxProbesPerPlan = 2;

    /// <summary>
    /// The longest the confinement probes can add to a run. Callers that advertise a latency ceiling must
    /// include it: probing happens before the child spawns, so it sits OUTSIDE the run's own timeout.
    /// Paid at most once per host process — every probe result is cached for its lifetime.
    /// </summary>
    public static readonly TimeSpan MaxProbeCost = ProbeTimeout * MaxProbesPerPlan;

    private static readonly Lazy<bool> ShellAvailable = new(() => !OperatingSystem.IsWindows() && File.Exists(ShellPath));

    private const string ShellPath = "/bin/sh";

    /// <summary>macOS's own sandbox launcher. Deprecated by Apple and still the only mechanism a plain
    /// process can apply to itself without an App Sandbox entitlement — which a command-line tool run
    /// from an editor does not have.</summary>
    private const string SandboxExecPath = "/usr/bin/sandbox-exec";

    /// <summary>Linux network denial: a network namespace with no interfaces in it. Wrapped in a USER
    /// namespace (<c>--map-root-user</c>) because creating a network namespace otherwise needs
    /// <c>CAP_SYS_ADMIN</c>, which an editor backend does not have and must not want.</summary>
    private static readonly string[] UnshareArguments = ["--user", "--map-root-user", "--net"];

    private static readonly Lazy<bool> MacSandboxAvailable = new(() =>
        OperatingSystem.IsMacOS()
        && File.Exists(SandboxExecPath)
        && Probe(SandboxExecPath, ["-p", MacProfile(Path.GetTempPath(), ScenarioSandboxOptions.Default), TruePath()]));

    private static readonly Lazy<string?> UnsharePath = new(() =>
        OperatingSystem.IsLinux() ? Locate("unshare") : null);

    private static readonly Lazy<bool> UnshareAvailable = new(() =>
        UnsharePath.Value is { } unshare && Probe(unshare, [.. UnshareArguments, TruePath()]));

    /// <summary>The hidden <c>koine</c> verb that installs a Landlock ruleset on itself and then
    /// <c>exec</c>s the real command (issue #1781). Named here rather than in the CLI because the sandbox
    /// is what COMPOSES the invocation; the command class binds its own name to this constant.</summary>
    internal const string LandlockLauncherVerb = "sandbox-landlock";

    /// <summary>How to invoke this same binary as the Landlock launcher, or <c>null</c> where that cannot
    /// be resolved (an embedder whose <c>koine</c> is reachable only through the host's command
    /// override — see <see cref="ScenarioExecutionHost.ResolveSelfCommand"/>).</summary>
    private static readonly Lazy<(string FileName, IReadOnlyList<string> Arguments)?> LandlockLauncher =
        new(() => OperatingSystem.IsLinux()
            ? ScenarioExecutionHost.ResolveSelfCommand(LandlockLauncherVerb)
            : null);

    /// <summary>
    /// Whether this Linux can confine the child's writes. Both halves are necessary and neither is assumed:
    /// the KERNEL must speak Landlock (ABI v1, 5.13+, not disabled through <c>lsm=</c>, on an architecture
    /// whose syscall numbers are known), and the launcher that installs the ruleset must be resolvable.
    /// Unlike an unprivileged network namespace, Landlock needs no privileges and no user namespace at all,
    /// so this stays true on the AppArmor-restricted hosts where <see cref="UnshareAvailable"/> is false.
    /// </summary>
    private static readonly Lazy<bool> LandlockAvailable = new(() =>
        OperatingSystem.IsLinux() && LandlockLauncher.Value is { } launcher
        && File.Exists(launcher.FileName) && LinuxLandlock.AbiVersion >= 1);

    /// <summary>
    /// Whether this platform can confine the child's WRITES to its run directory. False does not mean the
    /// scenario will not run — it means the run will carry a note saying so (see
    /// <see cref="ScenarioConfinement.Degradations"/>). Exposed so the sandbox's own tests can assert the
    /// enforced behaviour where it exists and skip — rather than fail — where it does not.
    /// </summary>
    public static bool FilesystemConfinementAvailable =>
        (OperatingSystem.IsMacOS() && MacSandboxAvailable.Value)
        || (OperatingSystem.IsLinux() && LandlockAvailable.Value);

    /// <summary>Whether this platform can deny the child the network. See
    /// <see cref="FilesystemConfinementAvailable"/> for what a <c>false</c> means.</summary>
    public static bool NetworkConfinementAvailable =>
        (OperatingSystem.IsMacOS() && MacSandboxAvailable.Value)
        || (OperatingSystem.IsLinux() && UnshareAvailable.Value);

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

            if (options.RestrictFilesystem && FilesystemConfinementAvailable)
            {
                // The child's temp directory has to sit INSIDE the only place it may write. The host's
                // scrub keeps TMPDIR, which names the PARENT of the run directory — so a runtime that
                // wants a temp path (Directory.CreateTempSubdirectory, a lock file, a shadow copy) would
                // put it exactly where the confinement says no, and get an UnauthorizedAccessException for
                // a reason that has nothing to do with the model. Pointing it at the run directory makes
                // that write legal and, as a bonus, inside what the host deletes when the run ends.
                foreach (string name in (string[])["TMPDIR", "TMP", "TEMP"])
                {
                    environment[name] = runDirectory;
                }
            }

            if (!OperatingSystem.IsWindows())
            {
                PlanUnix(ref file, args, runDirectory, options, degradations);
            }
            else if (options.DenyNetwork || options.RestrictFilesystem)
            {
                // Windows CAN confine a child this way — a restricted or low-integrity token — but only
                // through CreateProcessAsUser, which means abandoning Process.Start and hand-plumbing all
                // three redirected pipes. Until that exists, say so rather than let the caps imply it.
                degradations.Add("Filesystem and network confinement were not applied: the sandbox has no "
                    + "Windows mechanism for them yet, so this run kept its resource ceilings, its process "
                    + "isolation and its wall-clock deadline, and nothing stopped the executed code from "
                    + "reading or writing files.");
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
        ref string file,
        List<string> args,
        string runDirectory,
        ScenarioSandboxOptions options,
        List<string> degradations)
    {
        // Innermost first: the filesystem/network confiner execs into the real command, and the ulimit
        // shell below then wraps the confiner — so RLIMIT_CPU is in force for both, and the confinement
        // is in force for everything the command goes on to do.
        if (options.DenyNetwork || options.RestrictFilesystem)
        {
            PlanUnixIsolation(ref file, args, runDirectory, options, degradations);
        }

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

        Wrap(ref file, args, ShellPath, ["-c", script]);
    }

    /// <summary>
    /// Applies this Unix's filesystem/network confinement by making the child BE the confining launcher,
    /// which execs into the real command: macOS has <c>sandbox-exec</c>, which does both; Linux has a
    /// network namespace, which does one of the two. Anything neither covers is reported, not enforced.
    /// </summary>
    private static void PlanUnixIsolation(
        ref string file,
        List<string> args,
        string runDirectory,
        ScenarioSandboxOptions options,
        List<string> degradations)
    {
        if (OperatingSystem.IsMacOS())
        {
            if (!MacSandboxAvailable.Value)
            {
                degradations.Add("Filesystem and network confinement were not applied: " + SandboxExecPath
                    + " is unavailable or rejected the sandbox's profile, so this run kept its resource "
                    + "ceilings, its process isolation and its wall-clock deadline.");
                return;
            }

            Wrap(ref file, args, SandboxExecPath, ["-p", MacProfile(runDirectory, options)]);
            return;
        }

        if (OperatingSystem.IsLinux())
        {
            // INNERMOST FIRST, and the order is load-bearing. The Landlock launcher must sit INSIDE the
            // network namespace: a ruleset is irrevocable once installed and denies the mount and /proc
            // writes `unshare` needs to build its namespaces, so confining first would break the wrapper
            // that has not run yet. It must equally sit inside the `ulimit` shell added by PlanUnix.
            if (options.RestrictFilesystem)
            {
                if (LandlockAvailable.Value && LandlockLauncher.Value is { } launcher)
                {
                    Wrap(ref file, args, launcher.FileName,
                        [.. launcher.Arguments, "--run", runDirectory, "--"]);
                }
                else
                {
                    // Reads are unrestricted here in any case (ADR 0012): the child must load the .NET
                    // shared framework, which does not live in its run directory.
                    degradations.Add("Filesystem confinement was not applied: this Linux host offers no "
                        + "mechanism the sandbox can apply without a helper, so nothing stopped the executed "
                        + "code from reading or writing files outside its run directory.");
                }
            }

            if (!options.DenyNetwork)
            {
                return;
            }

            if (!UnshareAvailable.Value)
            {
                degradations.Add("Network confinement was not applied: an unprivileged network namespace "
                    + "could not be created here (unshare is missing, or unprivileged user namespaces are "
                    + "disabled — Ubuntu 23.10 and later restrict them by default through AppArmor's "
                    + "kernel.apparmor_restrict_unprivileged_userns), so nothing stopped the executed code "
                    + "from opening a connection.");
                return;
            }

            Wrap(ref file, args, UnsharePath.Value!, UnshareArguments);
            return;
        }

        degradations.Add("Filesystem and network confinement were not applied: this platform has no "
            + "mechanism the sandbox knows how to use, so the run kept its resource ceilings, its process "
            + "isolation and its wall-clock deadline.");
    }

    /// <summary>Makes <paramref name="launcher"/> the command, with the previous command and its arguments
    /// appended after <paramref name="launcherArguments"/> — the shape every one of these wrappers takes.</summary>
    private static void Wrap(
        ref string file, List<string> args, string launcher, IReadOnlyList<string> launcherArguments)
    {
        List<string> wrapped = [.. launcherArguments, file, .. args];
        args.Clear();
        args.AddRange(wrapped);
        file = launcher;
    }

    /// <summary>
    /// The macOS sandbox profile: everything stays allowed except the two things the trust model cannot
    /// vouch for. Reads are DELIBERATELY untouched — the child must load the .NET runtime, its own
    /// assemblies and the shared framework, all of which live outside the run directory, and a read
    /// restriction tight enough to matter would stop the runtime starting.
    /// </summary>
    private static string MacProfile(string runDirectory, ScenarioSandboxOptions options)
    {
        var profile = new StringBuilder();
        profile.Append("(version 1)\n(allow default)\n");

        if (options.DenyNetwork)
        {
            profile.Append("(deny network*)\n");
        }

        if (options.RestrictFilesystem)
        {
            profile.Append("(deny file-write*)\n");
            foreach (string writable in Writable(runDirectory))
            {
                profile.Append("(allow file-write* (subpath ").Append(Literal(writable)).Append("))\n");
            }

            // The character devices a process legitimately writes to without touching the filesystem.
            profile.Append("(allow file-write-data (literal \"/dev/null\") (literal \"/dev/zero\") ")
                .Append("(literal \"/dev/random\") (literal \"/dev/urandom\") ")
                .Append("(literal \"/dev/dtracehelper\"))\n")
                .Append("(allow file-ioctl (literal \"/dev/dtracehelper\"))\n");
        }

        return profile.ToString();
    }

    /// <summary>
    /// The run directory as the profile must name it. A sandbox rule is matched against the path the
    /// KERNEL resolved, so a directory reached through a symlink — which every macOS temp directory is,
    /// <c>/var</c> being a link to <c>/private/var</c> — has to be listed canonically or the rule silently
    /// matches nothing. Both forms are emitted rather than one, so a resolution that fails still leaves a
    /// working rule.
    /// </summary>
    private static IEnumerable<string> Writable(string runDirectory)
    {
        var paths = new List<string> { runDirectory };
        if (Canonical(runDirectory) is { } canonical && !paths.Contains(canonical, StringComparer.Ordinal))
        {
            paths.Add(canonical);
        }

        return paths;
    }

    /// <summary>Resolves every symlinked segment of <paramref name="path"/>, or <c>null</c> if it cannot.</summary>
    private static string? Canonical(string path)
    {
        try
        {
            string current = Path.DirectorySeparatorChar.ToString();
            foreach (string segment in Path.GetFullPath(path)
                         .Split(Path.DirectorySeparatorChar, StringSplitOptions.RemoveEmptyEntries))
            {
                current = Path.Combine(current, segment);
                if (new DirectoryInfo(current).ResolveLinkTarget(returnFinalTarget: true) is { } target)
                {
                    current = target.FullName;
                }
            }

            return current;
        }
        catch (Exception)
        {
            return null;
        }
    }

    /// <summary>A path as a Scheme string literal for the profile.</summary>
    private static string Literal(string path) =>
        "\"" + path.Replace("\\", "\\\\", StringComparison.Ordinal)
            .Replace("\"", "\\\"", StringComparison.Ordinal) + "\"";

    /// <summary>The absolute path of a program on this Unix, searched where the base system keeps them
    /// and then on PATH — never a bare name, which would let the OS pick the search order.</summary>
    private static string? Locate(string name)
    {
        foreach (string directory in (string[])["/usr/bin", "/bin", "/usr/sbin", "/sbin"])
        {
            string candidate = Path.Combine(directory, name);
            if (File.Exists(candidate))
            {
                return candidate;
            }
        }

        if (Environment.GetEnvironmentVariable("PATH") is not { Length: > 0 } path)
        {
            return null;
        }

        foreach (string entry in path.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
        {
            try
            {
                string candidate = Path.Combine(entry.Trim('"'), name);
                if (File.Exists(candidate))
                {
                    return Path.GetFullPath(candidate);
                }
            }
            catch (Exception)
            {
                // A malformed PATH entry is skipped, not fatal.
            }
        }

        return null;
    }

    /// <summary>The no-op program the availability probes run: the cheapest command that proves a wrapper
    /// can launch something at all.</summary>
    private static string TruePath() => Locate("true") ?? "/usr/bin/true";

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
    /// The note for <paramref name="failure"/> when it is really a RESOURCE ceiling being reached rather
    /// than a fault in the model — or <c>null</c> when it is not.
    ///
    /// <para>Consulted wherever the child catches an exception, because that is where a heap-limit
    /// <see cref="OutOfMemoryException"/> actually surfaces: the executor catches around both the emit +
    /// compile step and the reflective invoke, so an OOM never reaches an outer handler. Reporting it as
    /// a generic "the scenario could not be executed" would be true and useless — it reads as a machine
    /// problem, when what happened is a model-derived allocation meeting its budget.</para>
    /// </summary>
    public static string? ResourceCeilingNote(Exception failure) =>
        failure is OutOfMemoryException ? HeapCeilingNote() : null;

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
