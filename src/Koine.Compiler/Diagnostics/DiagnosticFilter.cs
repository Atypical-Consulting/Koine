using System.Text.RegularExpressions;

namespace Koine.Compiler.Diagnostics;

/// <summary>
/// Configuration for a <see cref="DiagnosticFilter"/> pass: per-code severity overrides and the
/// global warnings-as-errors promotion. Both default to "do nothing", so the no-arg
/// <see cref="None"/> instance leaves a diagnostic list untouched (modulo any in-source
/// <c># koine:disable</c> directives, which are scanned from the source text, not configured here).
/// </summary>
/// <param name="SeverityOverrides">
/// Maps a diagnostic code (e.g. <c>KOI0311</c>) to a build-severity string —
/// <c>none</c> | <c>hidden</c> | <c>info</c> | <c>warning</c> | <c>error</c>. Unknown codes/values
/// are ignored. <c>none</c> drops the diagnostic.
/// </param>
/// <param name="WarningsAsErrors">When true, every remaining <see cref="DiagnosticSeverity.Warning"/> is promoted to <see cref="DiagnosticSeverity.Error"/>.</param>
public sealed record DiagnosticFilterOptions(
    IReadOnlyDictionary<string, string>? SeverityOverrides = null,
    bool WarningsAsErrors = false)
{
    /// <summary>The no-op options: no overrides, no warnings-as-errors.</summary>
    public static readonly DiagnosticFilterOptions None = new();

    /// <summary>True when neither overrides nor warnings-as-errors are configured.</summary>
    public bool IsNoop => (SeverityOverrides is null || SeverityOverrides.Count == 0) && !WarningsAsErrors;
}

/// <summary>
/// A pure, target-agnostic remap/suppression pass applied to a diagnostic list before
/// <c>CompileResult.Success</c> is computed. It takes only primitives (a severity-override map, a
/// warnings-as-errors flag, and the source text(s)) — it has no dependency on the CLI or any emitter.
///
/// <para>The three inputs are applied in this fixed, asserted order:</para>
/// <list type="number">
/// <item>config severity overrides — remap each diagnostic's severity (<c>none</c> marks it for dropping);</item>
/// <item><c>--warnings-as-errors</c> — promote every remaining <see cref="DiagnosticSeverity.Warning"/> to <see cref="DiagnosticSeverity.Error"/>
/// (so a code overridden to <c>warning</c> then warnings-as-errors becomes <c>error</c>);</item>
/// <item><c># koine:disable CODE[, CODE...]</c> in-source directives — drop a matching diagnostic whose
/// line equals the directive's line (same-line suppression);</item>
/// <item>drop any diagnostic whose effective severity is <c>none</c> (the disabled/suppressed sentinel).
/// <c>hidden</c>/<c>info</c> are kept — only <c>error</c> ever makes a build fail.</item>
/// </list>
/// </summary>
public static class DiagnosticFilter
{
    /// <summary>
    /// The directive that suppresses diagnostics on its own line:
    /// <c>// koine:disable CODE[, CODE ...]</c>. The comment leader is <c>//</c> (the Koine line-comment,
    /// so the directive survives parsing of a <c>.koi</c> file) or <c>#</c> (accepted for non-Koine hosts);
    /// the codes follow as a comma/space-separated list.
    /// </summary>
    private static readonly Regex DisableDirective =
        new(@"(?://|\#)\s*koine:disable\s+(?<codes>[A-Za-z0-9_,\s]+)", RegexOptions.Compiled);

    /// <summary>The sentinel value that marks a diagnostic for dropping.</summary>
    private const string NoneValue = "none";

    /// <summary>
    /// Applies the filter to <paramref name="diagnostics"/> using <paramref name="options"/> and the
    /// in-source <c># koine:disable</c> directives scanned from <paramref name="sources"/> (each a
    /// <c>(file, text)</c> pair; the file is matched against the diagnostic's <see cref="Diagnostic.File"/>).
    /// Returns the remapped/filtered list; the original list is never mutated. A fast path returns the
    /// input unchanged when there is nothing to do.
    /// </summary>
    public static IReadOnlyList<Diagnostic> Apply(
        IReadOnlyList<Diagnostic> diagnostics,
        DiagnosticFilterOptions options,
        IReadOnlyList<(string? File, string Source)> sources)
    {
        var suppressions = ScanDisableDirectives(sources);
        if (options.IsNoop && suppressions.Count == 0)
        {
            return diagnostics;
        }

        var overrides = options.SeverityOverrides;
        var result = new List<Diagnostic>(diagnostics.Count);
        foreach (Diagnostic diag in diagnostics)
        {
            DiagnosticSeverity severity = diag.Severity;
            var drop = false;

            // (a) config severity overrides — remap per the map; `none` marks for dropping.
            if (overrides is not null && overrides.TryGetValue(diag.Code, out var raw)
                && TryParseSeverity(raw, out DiagnosticSeverity mapped, out bool isNone))
            {
                if (isNone)
                {
                    drop = true;
                }
                else
                {
                    severity = mapped;
                }
            }

            // (b) --warnings-as-errors — promote remaining Warning → Error (beats a `= warning` override).
            if (!drop && options.WarningsAsErrors && severity == DiagnosticSeverity.Warning)
            {
                severity = DiagnosticSeverity.Error;
            }

            // (c) `# koine:disable CODE` — drop a matching diagnostic on the directive's line.
            if (!drop && IsSuppressed(suppressions, diag))
            {
                drop = true;
            }

            // (d) drop the `none`/suppressed sentinel; keep hidden/info/warning/error.
            if (drop)
            {
                continue;
            }

            result.Add(severity == diag.Severity ? diag : diag with { Severity = severity });
        }

        return result;
    }

    /// <summary>Single-source convenience overload.</summary>
    public static IReadOnlyList<Diagnostic> Apply(
        IReadOnlyList<Diagnostic> diagnostics,
        DiagnosticFilterOptions options,
        string source,
        string? file = null) =>
        Apply(diagnostics, options, new[] { (file, source) });

    /// <summary>
    /// Parses a build-severity word into a <see cref="DiagnosticSeverity"/>. <c>none</c> sets
    /// <paramref name="isNone"/> (the drop sentinel) with <paramref name="severity"/> unused.
    /// Returns false for unknown words (the override is then ignored).
    /// </summary>
    private static bool TryParseSeverity(string value, out DiagnosticSeverity severity, out bool isNone)
    {
        severity = default;
        isNone = false;
        switch (value.Trim().ToLowerInvariant())
        {
            case NoneValue:
                isNone = true;
                return true;
            case "hidden":
                severity = DiagnosticSeverity.Hidden;
                return true;
            case "info":
                severity = DiagnosticSeverity.Info;
                return true;
            case "warning":
                severity = DiagnosticSeverity.Warning;
                return true;
            case "error":
                severity = DiagnosticSeverity.Error;
                return true;
            default:
                return false;
        }
    }

    /// <summary>
    /// Scans every source for <c># koine:disable CODE[, CODE ...]</c> directives, returning a map from
    /// <c>(file, 1-based line)</c> to the set of codes suppressed on that line. The file key is the
    /// pair's path (or <c>null</c>, matched against a diagnostic's null file).
    /// </summary>
    private static Dictionary<(string? File, int Line), HashSet<string>> ScanDisableDirectives(
        IReadOnlyList<(string? File, string Source)> sources)
    {
        var map = new Dictionary<(string?, int), HashSet<string>>();
        foreach ((string? file, string source) in sources)
        {
            // Cheap pre-filter: the overwhelmingly common source has no directive at all, so skip the
            // per-line Split + regex entirely unless the marker substring is present. This keeps the
            // no-op compile path (no overrides/flag/directives) from scanning every line for nothing.
            if (source.IndexOf("koine:disable", StringComparison.OrdinalIgnoreCase) < 0)
            {
                continue;
            }

            var lines = source.Split('\n');
            for (var i = 0; i < lines.Length; i++)
            {
                Match m = DisableDirective.Match(lines[i]);
                if (!m.Success)
                {
                    continue;
                }

                var key = (file, i + 1); // 1-based line, matching Diagnostic.Line.
                if (!map.TryGetValue(key, out HashSet<string>? codes))
                {
                    codes = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                    map[key] = codes;
                }

                foreach (var code in m.Groups["codes"].Value.Split(new[] { ',', ' ', '\t', '\r' }, StringSplitOptions.RemoveEmptyEntries))
                {
                    // A directive's codes are code-shaped tokens (letters then digits, e.g. KOI0101).
                    // Filtering by "contains a digit" drops a trailing free-text justification
                    // (`// koine:disable KOI0101 because ...`) so prose words can't suppress diagnostics.
                    if (code.Any(char.IsDigit))
                    {
                        codes.Add(code);
                    }
                }
            }
        }

        return map;
    }

    /// <summary>True when a <c># koine:disable</c> directive on the diagnostic's own line names its code.</summary>
    private static bool IsSuppressed(
        Dictionary<(string? File, int Line), HashSet<string>> suppressions, Diagnostic diag) =>
        suppressions.TryGetValue((diag.File, diag.Line), out HashSet<string>? codes) && codes.Contains(diag.Code);
}
