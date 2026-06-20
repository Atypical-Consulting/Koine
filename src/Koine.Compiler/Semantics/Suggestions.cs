namespace Koine.Compiler.Semantics;

/// <summary>
/// "Did you mean …?" suggestions: finds the closest in-scope candidate to a
/// mistyped name by Levenshtein distance (≤ 2), used to enrich unknown-name
/// diagnostics.
/// </summary>
internal static class Suggestions
{
    private const int MaxDistance = 2;

    /// <summary>
    /// Returns <c> — did you mean 'X'?</c> for the nearest candidate within the
    /// distance threshold, or an empty string when none qualifies. The wrapped prose for a
    /// diagnostic message; <see cref="Best"/> exposes the same bare candidate for tooling.
    /// </summary>
    public static string For(string target, IEnumerable<string> candidates) =>
        Best(target, candidates) is { } best ? $" — did you mean '{best}'?" : string.Empty;

    /// <summary>
    /// The nearest in-scope candidate to <paramref name="target"/> within the distance threshold,
    /// or <c>null</c> when none qualifies — the bare suggestion, free of the prose wrapper, for the
    /// structured <c>Diagnostic.Suggestion</c> and the code-fix providers.
    /// </summary>
    public static string? Best(string target, IEnumerable<string> candidates)
    {
        string? best = null;
        var bestDistance = int.MaxValue;

        foreach (var candidate in candidates)
        {
            if (candidate == target)
            {
                continue;
            }

            var distance = Levenshtein(target, candidate);
            if (distance < bestDistance || (distance == bestDistance && string.CompareOrdinal(candidate, best) < 0))
            {
                bestDistance = distance;
                best = candidate;
            }
        }

        return best is not null && bestDistance <= MaxDistance ? best : null;
    }

    private static int Levenshtein(string a, string b)
    {
        var prev = new int[b.Length + 1];
        var curr = new int[b.Length + 1];
        for (var j = 0; j <= b.Length; j++)
        {
            prev[j] = j;
        }

        for (var i = 1; i <= a.Length; i++)
        {
            curr[0] = i;
            for (var j = 1; j <= b.Length; j++)
            {
                var cost = a[i - 1] == b[j - 1] ? 0 : 1;
                curr[j] = Math.Min(Math.Min(curr[j - 1] + 1, prev[j] + 1), prev[j - 1] + cost);
            }
            (prev, curr) = (curr, prev);
        }

        return prev[b.Length];
    }
}
