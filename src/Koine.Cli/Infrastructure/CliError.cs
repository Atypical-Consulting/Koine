namespace Koine.Cli.Infrastructure;

/// <summary>
/// Plain-text error reporting shared by the commands. A <em>runtime</em> error means the
/// flags parsed fine but the input did not (missing file, no <c>.koi</c> files, unsupported
/// target, parse failure). It prints <c>error: &lt;message&gt;</c> (plus an optional
/// <c>hint:</c> line) to stderr and returns the non-zero exit code, so callers can
/// <c>return CliError.Runtime(...)</c>. Kept free of Spectre markup so the output stays
/// scriptable and matches what the surrounding tooling expects.
/// </summary>
internal static class CliError
{
    public static int Runtime(string message, string? hint = null)
    {
        Console.Error.WriteLine($"error: {message}");
        if (hint is not null)
        {
            Console.Error.WriteLine($"hint: {hint}");
        }

        return 1;
    }
}
