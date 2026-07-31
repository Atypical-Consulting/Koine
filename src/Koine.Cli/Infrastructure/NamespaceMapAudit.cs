using Koine.Compiler.Ast;

namespace Koine.Cli.Infrastructure;

/// <summary>
/// Cross-checks a target's <c>koine.config</c> namespace-map keys (issue #1255) against the compiled
/// model's actual bounded-context names. Every <see cref="TargetOptions.NamespaceMap"/> consumer (the
/// C#/TypeScript/PHP/Rust/Python/Kotlin/Java providers) only ever remaps a context whose name matches a
/// key exactly, so a key that names no real context — a typo, or a non-ASCII/grammar-illegal name per
/// #1239/PR #1251's review — silently produces a namespace-map entry that never applies to anything.
/// This turns that silent no-op into a warning (not a hard error — a key can legitimately name a
/// context staged for a future <c>.koi</c> addition) naming the offending key and target.
/// </summary>
internal static class NamespaceMapAudit
{
    /// <summary>
    /// Returns one warning message per <paramref name="options"/>' <see cref="TargetOptions.NamespaceMap"/>
    /// key that matches no context in <paramref name="model"/>, or an empty list when every key matches
    /// (including when the map itself is empty).
    /// </summary>
    public static IReadOnlyList<string> UnmatchedKeyWarnings(string target, TargetOptions options, KoineModel model)
    {
        if (options.NamespaceMap.Count == 0)
        {
            return Array.Empty<string>();
        }

        var contextNames = new HashSet<string>(model.Contexts.Select(c => c.Name), StringComparer.Ordinal);
        List<string>? warnings = null;
        foreach (var key in options.NamespaceMap.Keys)
        {
            if (contextNames.Contains(key))
            {
                continue;
            }

            warnings ??= new List<string>();
            warnings.Add(
                $"warning: koine.config namespace-map key '{key}' for target '{target}' does not match any context in the model");
        }

        return (IReadOnlyList<string>?)warnings ?? Array.Empty<string>();
    }
}
