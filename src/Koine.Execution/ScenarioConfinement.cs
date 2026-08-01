using System.Diagnostics;
using System.Globalization;

namespace Koine.Execution;

/// <summary>
/// The confinement the sandbox actually managed to arrange for one run: the (possibly rewritten) command
/// to spawn, the environment to spawn it with, whatever must be attached to the child once it exists,
/// and — the part the user sees — an honest list of everything that was ASKED for and could not be
/// applied here.
///
/// <para>Produced by <see cref="ScenarioSandbox.Plan"/>. A plan is always runnable: when nothing can be
/// enforced, <see cref="FileName"/>/<see cref="Arguments"/> are the caller's own command untouched and
/// <see cref="Degradations"/> says so. That is the contract — confinement never turns a working scenario
/// into a failed one (issue #1759).</para>
/// </summary>
internal sealed class ScenarioConfinement : IDisposable
{
    /// <summary>Unix reports a signal-terminated child as <c>128 + signal</c>; <c>SIGXCPU</c> is 24, and
    /// it is what <c>RLIMIT_CPU</c> raises when the soft processor-time limit is reached.</summary>
    internal const int UnixCpuLimitExitCode = 152;

    /// <summary><c>128 + SIGKILL</c>. <c>ulimit -t</c> sets the soft AND hard <c>RLIMIT_CPU</c> to the same
    /// value, so a child that is not reaped the instant <c>SIGXCPU</c> lands meets the hard limit a moment
    /// later and is killed outright — which shell and kernel decide is observed varies by distribution,
    /// so both codes have to be read as the same event.</summary>
    internal const int UnixKilledExitCode = 137;

    /// <summary>Windows terminates a job that blows its TIME limit with <c>STATUS_QUOTA_EXCEEDED</c>,
    /// which surfaces as this (negative, when read as a signed exit code) NTSTATUS.</summary>
    internal const int WindowsQuotaExceededExitCode = unchecked((int)0xC0000044);

    /// <summary><c>ERROR_NOT_ENOUGH_QUOTA</c> — the Win32 form of the same end-of-job-time termination,
    /// which is what MSDN documents for <c>JOB_OBJECT_TERMINATE_AT_END_OF_JOB</c>. Both are accepted
    /// because which one a process exits with is not something to bet a diagnostic on.</summary>
    internal const int WindowsNotEnoughQuotaExitCode = 1816;

    private readonly List<string> _degradations = [];
    private readonly ScenarioSandboxOptions _options;
    private readonly bool _confineWindowsFilesystem;
    private WindowsJobObject? _job;

    internal ScenarioConfinement(
        string fileName,
        IReadOnlyList<string> arguments,
        IReadOnlyDictionary<string, string> environment,
        ScenarioSandboxOptions options,
        IEnumerable<string> degradations,
        bool confineWindowsFilesystem = false)
    {
        FileName = fileName;
        Arguments = arguments;
        Environment = environment;
        _options = options;
        _confineWindowsFilesystem = confineWindowsFilesystem;
        _degradations.AddRange(degradations);
    }

    /// <summary>The executable to spawn — the caller's own, or the confining wrapper that execs into it.</summary>
    public string FileName { get; }

    /// <summary>The arguments to spawn it with, already carrying the caller's own command when wrapped.</summary>
    public IReadOnlyList<string> Arguments { get; }

    /// <summary>Environment variables the confinement needs SET on the child, applied after the host's
    /// own scrub so they survive it.</summary>
    public IReadOnlyDictionary<string, string> Environment { get; }

    /// <summary>What was asked for and could not be applied on this platform, in the words the result
    /// tree shows the user. Empty when everything requested was enforced.</summary>
    public IReadOnlyList<string> Degradations => _degradations;

    /// <summary>
    /// Starts the child ITSELF, where this platform's confinement can only be applied at creation —
    /// today, a Windows low-integrity token (issue #1780), which <see cref="Process.Start(ProcessStartInfo)"/>
    /// cannot supply. Returns <c>null</c> everywhere else, and on a Windows host that could not manage
    /// it after all, so the caller's own <c>Process.Start</c> stays the fallback on every path.
    ///
    /// <para>The returned child is SUSPENDED: <see cref="Attach"/> gets to put it in its Job Object
    /// before its first instruction — a race the <c>Process.Start</c> path cannot close — and
    /// <see cref="ScenarioChildProcess.Resume"/> then lets it run.</para>
    ///
    /// <para>A launch that fails here appends the degradation itself, because <see cref="ScenarioSandbox.Plan"/>
    /// had already decided it COULD confine and so wrote no note.</para>
    /// </summary>
    public ScenarioChildProcess? TryLaunch(ProcessStartInfo startInfo)
    {
        if (!OperatingSystem.IsWindows() || !_confineWindowsFilesystem)
        {
            return null;
        }

        WindowsConfinedProcess? confined = WindowsConfinedProcess.TryStart(startInfo, out string? failure);
        if (confined is null)
        {
            _degradations.Add(ScenarioSandbox.WindowsFilesystemNote(failure));
            return null;
        }

        return ScenarioChildProcess.Suspended(
            confined.Process, confined.StandardInput, confined.StandardOutput, confined.StandardError,
            confined.Resume, confined);
    }

    /// <summary>Applies the confinement that can only exist once the process does — today, the Windows
    /// Job Object. A failure here is a degradation, never an error: the child is already running.</summary>
    public void Attach(Process child)
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        _job = WindowsJobObject.TryCreate(
            WindowsJobCommitLimitFor(_options.MemoryLimitBytes), _options.CpuLimit, out string? failure);
        if (_job is null)
        {
            if (failure is not null)
            {
                _degradations.Add("The sandbox's memory and processor-time ceilings were not enforced by the "
                    + "operating system because " + failure + "; the run kept its wall-clock deadline and the "
                    + "runtime's own heap ceiling.");
            }

            return;
        }

        if (!_job.TryAssign(child, out string? assignFailure))
        {
            _degradations.Add("The sandbox's memory and processor-time ceilings were not enforced by the "
                + "operating system because " + assignFailure + "; the run kept its wall-clock deadline and "
                + "the runtime's own heap ceiling.");
        }
    }

    /// <summary>
    /// The note for a child that died at a RESOURCE ceiling rather than at the wall-clock deadline, or
    /// <c>null</c> when the exit code says nothing about the caps. Distinguishing the two matters: telling
    /// a user their model loops forever when it actually allocated (or burned processor time) sends them
    /// hunting the wrong bug.
    /// </summary>
    public string? DescribeExit(int exitCode)
    {
        if (!OperatingSystem.IsWindows()
            && exitCode is UnixCpuLimitExitCode or UnixKilledExitCode
            && _options.CpuLimit is { } cpu)
        {
            return "The scenario was stopped with the sandbox's ceiling of " + Seconds(cpu) + " of PROCESSOR "
                + "time in force, having produced no result — almost certainly by reaching it. That is a "
                + "resource ceiling, not the wall-clock deadline: the emitted code ran hot (an unbounded loop "
                + "in a derived member or invariant) rather than merely slowly."
                + (exitCode == UnixKilledExitCode
                    ? " (The child was killed outright rather than signalled, which the system's "
                      + "out-of-memory killer or an external kill would also look like from here.)"
                    : string.Empty);
        }

        // Deliberately NOT a memory diagnosis: a JOB_OBJECT_LIMIT_JOB_MEMORY breach makes the offending
        // COMMIT fail rather than terminating the job, so it does not produce these exit codes. (It is not
        // as harmless as "the child sees an OutOfMemoryException and reports the ceiling itself" — WHICH
        // commit fails decides that, and a stack guard page fails as an uncatchable STATUS_STACK_OVERFLOW
        // instead. See WindowsJobCommitLimitFor, which keeps the job cap clear of the heap ceiling so that
        // case stays unreachable — issue #1791.) The only ceiling that terminates a job is the TIME one,
        // so that is the only ceiling this exit code can honestly be attributed to.
        if (OperatingSystem.IsWindows()
            && exitCode is WindowsQuotaExceededExitCode or WindowsNotEnoughQuotaExitCode
            && _options.CpuLimit is { } jobTime)
        {
            return "The scenario exceeded the sandbox's ceiling of " + Seconds(jobTime) + " of PROCESSOR "
                + "time and was stopped by the operating system. That is a resource ceiling, not the "
                + "wall-clock deadline: the emitted code ran hot (an unbounded loop in a derived member or "
                + "invariant) rather than merely slowly.";
        }

        return null;
    }

    public void Dispose()
    {
        // The guard is for the analyzer as much as for the runtime: _job is only ever created inside the
        // Windows branch of Attach, but the field's type is platform-gated and this method is not.
        if (OperatingSystem.IsWindows())
        {
            _job?.Dispose();
        }
    }

    private static string Seconds(TimeSpan value) =>
        value.TotalSeconds.ToString("0.##", CultureInfo.InvariantCulture) + "s";

    internal static string Mebibytes(long bytes) =>
        (bytes / (double)(1L << 20)).ToString("0.##", CultureInfo.InvariantCulture) + " MiB";

    /// <summary>
    /// How much committed memory the Job Object allows the child ON TOP OF the sandbox's managed-heap
    /// ceiling — everything a .NET child commits that is not the managed heap: the runtime image, JIT'd
    /// code, the loader heaps (Roslyn's are the large ones here), and every thread's stack.
    ///
    /// <para>Generous on purpose. Too small and the OS cap fires before the heap ceiling — the defect this
    /// constant exists to prevent (issue #1791) — while too large costs only the difference between two
    /// figures a runaway child reaches in the same instant either way.</para>
    /// </summary>
    private const long WindowsRuntimeCommitAllowanceBytes = 256L << 20;

    /// <summary>
    /// Translates the sandbox's MANAGED-HEAP ceiling into the JOB COMMIT cap that enforces it from
    /// outside. The two are not the same quantity and must not be set to the same number: <c>
    /// DOTNET_GCHeapHardLimit</c> bounds the managed heap alone, while <c>JOB_OBJECT_LIMIT_JOB_MEMORY</c>
    /// bounds every committed page in the job — runtime, JIT, loader heaps and thread stacks included.
    ///
    /// <para><b>Why the gap is load-bearing (issue #1791).</b> Starting a .NET child at all costs far more
    /// committed memory than a small ceiling — before a line of model-derived code runs. So setting the job
    /// cap AT the heap ceiling never meant "this much model allocation"; it meant "no further commit at
    /// all", and which page the child asked for next decided how it died: a GC heap commit surfaces as the
    /// <see cref="OutOfMemoryException"/> the sandbox knows how to name, but a STACK GUARD PAGE surfaces as
    /// <c>STATUS_STACK_OVERFLOW</c> — uncatchable, no result tree, and the ceiling goes unreported. On
    /// <c>windows-latest</c> that coin came up stack overflow about five times in six.</para>
    ///
    /// <para>The margin only got MORE load-bearing with issue #1780: <see cref="TryLaunch"/> now starts the
    /// child suspended so <see cref="Attach"/> joins it to the job before its first instruction. That closes
    /// a real race, but it also means the job charges the child's ENTIRE footprint rather than only what it
    /// commits after being joined — so the startup cost this allowance covers is now inside the cap on the
    /// confined path, not outside it.</para>
    ///
    /// <para>So the OS cap is deliberately the BACKSTOP and never the reporting path: the heap ceiling
    /// binds first and reports itself, and the job cap survives to stop the growth the GC cannot see —
    /// native allocations and runaway stacks — which is the reason it exists (issue #1759). A backstop
    /// that fires before the thing it backs up is not a backstop.</para>
    /// </summary>
    internal static long? WindowsJobCommitLimitFor(long? heapCeilingBytes) =>
        heapCeilingBytes is not { } ceiling || ceiling <= 0
            ? heapCeilingBytes
            : ceiling > long.MaxValue - WindowsRuntimeCommitAllowanceBytes
                ? long.MaxValue
                : ceiling + WindowsRuntimeCommitAllowanceBytes;
}
