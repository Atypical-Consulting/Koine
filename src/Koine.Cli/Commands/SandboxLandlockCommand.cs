using Koine.Execution;
using Spectre.Console.Cli;

namespace Koine.Cli.Commands;

/// <summary>
/// The Linux write-confinement launcher of the scenario sandbox (issue #1781, ADR 0012) — HIDDEN, like
/// <see cref="ScenarioExecCommand"/>, because it is an implementation detail of
/// <see cref="ScenarioSandbox"/> rather than a command a human runs.
///
/// <para><b>Why a verb and not a wrapper program.</b> <c>landlock_restrict_self(2)</c> can only be called
/// by the process it confines, and .NET has no hook between fork and exec — so the sandbox makes the child
/// BE this verb, which installs the ruleset on itself and then <c>execv</c>s the real command. The ruleset
/// survives the <c>execv</c> and cannot be relaxed afterwards, so what the command inherits is a process
/// that may read anywhere and write only beneath <c>--run</c>. Because it is an <c>exec</c> and not a
/// fork, the PID, the exit code and the three inherited pipes all keep belonging to the real command —
/// which is what leaves ADR 0011's process-tree kill and stdio protocol untouched.</para>
///
/// <para><b>It fails loud.</b> If the ruleset cannot be installed, this verb exits non-zero WITHOUT
/// running the command. The sandbox's contract — never fail a run because confinement is unavailable — is
/// discharged by the availability probe BEFORE the child is planned; once the plan says "confined", a
/// silent unconfined run would be the one outcome worse than no sandbox at all, because the result tree
/// would carry no note saying the code ran unrestricted.</para>
/// </summary>
internal sealed class SandboxLandlockCommand : Command<SandboxLandlockCommand.Settings>
{
    /// <summary>The verb itself, shared with <see cref="ScenarioSandbox"/> so the launcher the sandbox
    /// composes and the command this CLI registers can never drift apart.</summary>
    internal const string Verb = ScenarioSandbox.LandlockLauncherVerb;

    /// <summary>What the launcher exits with when it could not confine, or could not exec. Distinct from
    /// <c>1</c> so a failure HERE is not mistaken for the command's own exit code.</summary>
    private const int LauncherFailure = 78;

    internal sealed class Settings : CommandSettings
    {
        [CommandOption("--run <DIRECTORY>")]
        public string? RunDirectory { get; init; }
    }

    protected override int Execute(CommandContext context, Settings settings, CancellationToken cancellationToken)
    {
        if (!OperatingSystem.IsLinux())
        {
            return Fail("The Landlock launcher is a Linux mechanism; this platform has no ruleset to install.");
        }

        if (settings.RunDirectory is not { Length: > 0 } runDirectory || !Directory.Exists(runDirectory))
        {
            return Fail("--run must name an existing directory; the confinement has nowhere to allow writes.");
        }

        IReadOnlyList<string> command = context.Remaining.Raw;
        if (command.Count == 0)
        {
            return Fail("No command was given after `--`; the launcher has nothing to exec into.");
        }

        if (!LinuxLandlock.TryRestrict(runDirectory, out string? failure))
        {
            // Deliberately NOT falling through to the exec: see the class remarks.
            return Fail("The Landlock ruleset was not installed (" + failure
                + "), so the command was not run rather than run unconfined.");
        }

        // Only returns if the exec failed — on success this process IS the command from here on.
        return Fail(LinuxNative.Exec(command[0], command));
    }

    private static int Fail(string message)
    {
        Console.Error.WriteLine("koine " + Verb + ": " + message);
        return LauncherFailure;
    }
}
