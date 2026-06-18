using System.ComponentModel;
using Spectre.Console.Cli;

namespace Koine.Cli.Commands;

/// <summary>Flags for <c>init</c>.</summary>
internal sealed class InitSettings : CommandSettings
{
    [CommandArgument(0, "[dir]")]
    [Description("Directory to scaffold into (default: the current directory).")]
    public string Dir { get; init; } = ".";

    [CommandOption("--force")]
    [Description("Overwrite existing domain.koi / koine.config / README.md.")]
    public bool Force { get; init; }
}

/// <summary>Scaffolds a starter Koine project (R17.3).</summary>
internal sealed class InitCommand : Command<InitSettings>
{
    protected override int Execute(CommandContext context, InitSettings settings, CancellationToken cancellationToken)
        => Program.InitProject(settings.Dir, settings.Force, Console.Out, Console.Error) ? 0 : 1;
}
