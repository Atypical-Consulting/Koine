namespace Koine.Cli.Infrastructure;

/// <summary>
/// A parsed, config-resolved build invocation, shared by <c>build</c> and <c>watch</c>.
/// The raw flags live on <see cref="Commands.BuildSettings"/>; this is the result of
/// resolving them against any <c>koine.config</c> (R16.1).
/// </summary>
internal readonly record struct BuildPlan(
    string File,
    string Target,
    string? OutDir,
    string? GlossaryFile,
    string? DocsDir,
    TargetOptions Options,
    IReadOnlyDictionary<string, string>? DiagnosticSeverity = null,
    bool WarningsAsErrors = false);
