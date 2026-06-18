using BenchmarkDotNet.Reports;

namespace Koine.Compiler.Benchmarks;

/// <summary>
/// Splices BenchmarkDotNet's generated GitHub-markdown results into <c>README.md</c> between marker
/// comments, so a benchmark run keeps the committed numbers up to date instead of needing a manual
/// copy-paste. Triggered by the <c>--update-docs</c> CLI flag (see <c>Program.cs</c>).
/// </summary>
internal static class ReadmeUpdater
{
    private const string StartMarker = "<!-- BENCHMARK:RESULTS:START -->";
    private const string EndMarker = "<!-- BENCHMARK:RESULTS:END -->";

    public static void Update(IEnumerable<Summary> summaries)
    {
        // Collect the github report(s) BDN just wrote next to each summary's results.
        var reports = summaries
            .Select(s => s.ResultsDirectoryPath)
            .Where(d => d is not null && Directory.Exists(d))
            .Distinct()
            .SelectMany(d => Directory.EnumerateFiles(d, "*-report-github.md"))
            .Distinct()
            .OrderBy(p => p, StringComparer.Ordinal)
            .Select(File.ReadAllText)
            .ToList();

        if (reports.Count == 0)
        {
            Console.Error.WriteLine("[update-docs] no benchmark results found; README not updated.");
            return;
        }

        var readme = LocateReadme();
        if (readme is null)
        {
            Console.Error.WriteLine("[update-docs] README.md not found; skipped.");
            return;
        }

        var text = File.ReadAllText(readme);
        var start = text.IndexOf(StartMarker, StringComparison.Ordinal);
        var end = text.IndexOf(EndMarker, StringComparison.Ordinal);
        if (start < 0 || end < 0 || end < start)
        {
            Console.Error.WriteLine(
                $"[update-docs] markers '{StartMarker}'/'{EndMarker}' not found in {readme}; skipped.");
            return;
        }

        var table = string.Join(Environment.NewLine + Environment.NewLine, reports).TrimEnd();
        var rebuilt =
            text[..(start + StartMarker.Length)] +
            Environment.NewLine + Environment.NewLine +
            table +
            Environment.NewLine + Environment.NewLine +
            text[end..];

        File.WriteAllText(readme, rebuilt);
        Console.WriteLine($"[update-docs] updated {readme}");
    }

    /// <summary>Walks up from the run directory (bin/Release/netX) to the project folder's README.</summary>
    private static string? LocateReadme()
    {
        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
        {
            var readme = Path.Combine(dir.FullName, "README.md");
            var csproj = Path.Combine(dir.FullName, "Koine.Compiler.Benchmarks.csproj");
            if (File.Exists(readme) && File.Exists(csproj))
            {
                return readme;
            }
        }

        return null;
    }
}
