using System.Diagnostics;

namespace Koine.Execution;

/// <summary>
/// The running scenario child and the three streams the stdio protocol drives it through — whichever
/// way it was started.
///
/// <para><b>Why this exists.</b> <see cref="Process.Start(ProcessStartInfo)"/> cannot supply a custom
/// token, so the Windows confined path (issue #1780) builds its child with <c>CreateProcessAsUser</c>
/// and three pipes of its own. .NET offers no way to hand those streams back to a <see cref="Process"/>
/// — <c>StandardInput</c> and friends are only ever populated by <c>Process.Start</c> — so the host
/// cannot simply be given "a <see cref="Process"/>" and carry on. This carries the process AND its
/// streams together, so <see cref="ScenarioExecutionHost"/> reads one shape either way and the whole
/// difference between a confined and an unconfined launch stays inside
/// <see cref="ScenarioConfinement.TryLaunch"/>.</para>
///
/// <para>Deliberately platform-neutral: every member is a type that exists everywhere, so nothing about
/// the Windows mechanism leaks into the host's signatures.</para>
/// </summary>
internal sealed class ScenarioChildProcess : IDisposable
{
    private readonly IDisposable _owner;
    private readonly Action _resume;

    private ScenarioChildProcess(
        Process process,
        StreamWriter standardInput,
        StreamReader standardOutput,
        StreamReader standardError,
        Action resume,
        IDisposable owner)
    {
        Process = process;
        StandardInput = standardInput;
        StandardOutput = standardOutput;
        StandardError = standardError;
        _resume = resume;
        _owner = owner;
    }

    /// <summary>The child itself: its id, its exit code, its wait and its tree-kill.</summary>
    public Process Process { get; }

    public StreamWriter StandardInput { get; }

    public StreamReader StandardOutput { get; }

    public StreamReader StandardError { get; }

    /// <summary>An ordinary <see cref="Process.Start(ProcessStartInfo)"/> child, already running.</summary>
    public static ScenarioChildProcess Started(Process process) =>
        new(process, process.StandardInput, process.StandardOutput, process.StandardError,
            static () => { }, process);

    /// <summary>A child some confinement built itself, still SUSPENDED until <see cref="Resume"/>.</summary>
    public static ScenarioChildProcess Suspended(
        Process process,
        StreamWriter standardInput,
        StreamReader standardOutput,
        StreamReader standardError,
        Action resume,
        IDisposable owner) =>
        new(process, standardInput, standardOutput, standardError, resume, owner);

    /// <summary>Lets a suspended child run; a no-op for one that already is. Called after the caps that
    /// can only be attached to a live process are attached — which is the point of suspending it.</summary>
    public void Resume() => _resume();

    public void Dispose() => _owner.Dispose();
}
