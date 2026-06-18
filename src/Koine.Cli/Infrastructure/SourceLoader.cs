using Koine.Compiler.Services;

namespace Koine.Cli.Infrastructure;

/// <summary>
/// Shared <c>.koi</c> source loading for <c>build</c>/<c>fmt</c>/<c>check</c>: reads a single
/// <c>.koi</c> file, or every <c>.koi</c> under a directory (recursively, in a deterministic
/// order) — R13.1. The I/O and "nothing found" cases are turned into a single actionable
/// <see cref="CliError"/>.
/// </summary>
internal static class SourceLoader
{
    public static List<SourceFile> ReadSources(string path)
    {
        if (Directory.Exists(path))
        {
            return Directory.EnumerateFiles(path, "*.koi", SearchOption.AllDirectories)
                .OrderBy(p => p, StringComparer.Ordinal)
                .Select(p => new SourceFile(p, File.ReadAllText(p)))
                .ToList();
        }

        return new List<SourceFile> { new(path, File.ReadAllText(path)) };
    }

    /// <summary>
    /// Reads the sources for <paramref name="path"/>, returning <c>false</c> (with
    /// <paramref name="exitCode"/> set) on a missing/unreadable input or when no
    /// <c>.koi</c> files are found; otherwise yields the sources.
    /// </summary>
    public static bool TryReadSources(string path, string label, out List<SourceFile> sources, out int exitCode)
    {
        sources = new List<SourceFile>();
        exitCode = 0;
        try
        {
            sources = ReadSources(path);
        }
        catch (Exception ex) when (ex is FileNotFoundException or DirectoryNotFoundException)
        {
            exitCode = CliError.Runtime($"{label} not found: {path}", "run `koine init` to scaffold a starter model");
            return false;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            exitCode = CliError.Runtime($"cannot read {label} '{path}': {ex.Message}");
            return false;
        }

        if (sources.Count == 0)
        {
            exitCode = CliError.Runtime($"no .koi files found under '{path}'", "run `koine init` to scaffold a starter model");
            return false;
        }

        return true;
    }
}
