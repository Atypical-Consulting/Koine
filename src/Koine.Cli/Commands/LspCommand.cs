using Spectre.Console.Cli;

namespace Koine.Cli.Commands;

/// <summary>
/// Runs the Language Server over stdio. This command speaks raw JSON-RPC (see
/// <see cref="LspServer"/>) and must never have its output decorated, so it delegates
/// straight to <see cref="LspServer.Run"/>.
/// </summary>
internal sealed class LspCommand : Command<LspCommand.Settings>
{
    internal sealed class Settings : CommandSettings;

    protected override int Execute(CommandContext context, Settings settings, CancellationToken cancellationToken) => LspServer.Run();
}
