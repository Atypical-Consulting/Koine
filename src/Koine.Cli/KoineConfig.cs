namespace Koine.Cli;

/// <summary>
/// Minimal <c>koine.config</c> reader (R17.3): it supplies defaults for the
/// <c>build</c>/<c>watch</c> CLI flags when a flag is omitted. Only the flat keys
/// <c>target</c> and <c>out</c> are recognized today; the structured per-target
/// emitter options sketched in R16.1 (namespace maps, <c>instantMode</c>, layout)
/// are not yet implemented, so every other key — including a future
/// <c>targets.*</c> block — is ignored, keeping the file forward-compatible.
/// Lines are <c>key = value</c>; <c>#</c> starts a comment.
/// </summary>
internal sealed record KoineConfig(string? Target, string? OutDir, string? Baseline = null)
{
    public static readonly KoineConfig Empty = new(null, null);

    /// <summary>The conventional config file name, looked up beside the build input.</summary>
    public const string FileName = "koine.config";

    public static KoineConfig Parse(string text)
    {
        string? target = null;
        string? outDir = null;
        string? baseline = null;

        foreach (var raw in text.Split('\n'))
        {
            var line = StripComment(raw).Trim();
            if (line.Length == 0)
            {
                continue;
            }

            var eq = line.IndexOf('=');
            if (eq <= 0)
            {
                continue;
            }

            var key = line[..eq].Trim();
            var value = line[(eq + 1)..].Trim();
            if (value.Length == 0)
            {
                continue;
            }

            switch (key)
            {
                case "target":
                    target = value;
                    break;
                case "out":
                    outDir = value;
                    break;
                case "baseline":
                    baseline = value;
                    break;
                    // Unknown / structured keys (the R16 `targets.*` block, etc.) are
                    // intentionally ignored so older tooling tolerates newer configs.
            }
        }

        return new KoineConfig(target, outDir, baseline);
    }

    /// <summary>
    /// Loads the config beside <paramref name="inputPath"/> (its directory, or the
    /// directory itself when it is one), falling back to the current directory, or
    /// <see cref="Empty"/> if none is found.
    /// </summary>
    public static KoineConfig Discover(string inputPath)
    {
        foreach (var dir in CandidateDirs(inputPath))
        {
            var path = Path.Combine(dir, FileName);
            if (File.Exists(path))
            {
                return Parse(File.ReadAllText(path));
            }
        }
        return Empty;
    }

    private static IEnumerable<string> CandidateDirs(string inputPath)
    {
        var inputDir = Directory.Exists(inputPath) ? inputPath : Path.GetDirectoryName(inputPath);
        if (!string.IsNullOrEmpty(inputDir))
        {
            yield return inputDir;
        }

        yield return Directory.GetCurrentDirectory();
    }

    private static string StripComment(string line)
    {
        var hash = line.IndexOf('#');
        return hash < 0 ? line : line[..hash];
    }
}
