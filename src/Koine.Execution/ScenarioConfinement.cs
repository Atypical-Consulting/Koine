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

    /// <summary>Windows terminates a job that blows a quota with <c>STATUS_QUOTA_EXCEEDED</c>, which
    /// surfaces as this (negative, when read as a signed exit code) NTSTATUS.</summary>
    internal const int WindowsQuotaExceededExitCode = unchecked((int)0xC0000044);

    private readonly List<string> _degradations = [];
    private readonly ScenarioSandboxOptions _options;
    private WindowsJobObject? _job;

    internal ScenarioConfinement(
        string fileName,
        IReadOnlyList<string> arguments,
        IReadOnlyDictionary<string, string> environment,
        ScenarioSandboxOptions options,
        IEnumerable<string> degradations)
    {
        FileName = fileName;
        Arguments = arguments;
        Environment = environment;
        _options = options;
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

    /// <summary>Applies the confinement that can only exist once the process does — today, the Windows
    /// Job Object. A failure here is a degradation, never an error: the child is already running.</summary>
    public void Attach(Process child)
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        _job = WindowsJobObject.TryCreate(_options.MemoryLimitBytes, _options.CpuLimit, out string? failure);
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
            && exitCode == UnixCpuLimitExitCode
            && _options.CpuLimit is { } cpu)
        {
            return "The scenario exceeded the sandbox's ceiling of " + Seconds(cpu) + " of PROCESSOR time and "
                + "was stopped. That is a resource ceiling, not the wall-clock deadline: the emitted code ran "
                + "hot (an unbounded loop in a derived member or invariant) rather than merely slowly.";
        }

        if (OperatingSystem.IsWindows()
            && exitCode == WindowsQuotaExceededExitCode
            && (_options.MemoryLimitBytes is not null || _options.CpuLimit is not null))
        {
            return "The scenario exceeded one of the sandbox's resource ceilings"
                + (_options.MemoryLimitBytes is { } bytes ? " (memory: " + Mebibytes(bytes) + ")" : string.Empty)
                + " and was stopped by the operating system. That is a resource ceiling, not the wall-clock "
                + "deadline.";
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
}
