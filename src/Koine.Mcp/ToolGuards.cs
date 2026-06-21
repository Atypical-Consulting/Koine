using System.Text;

namespace Koine.Mcp;

/// <summary>
/// Cheap, transport-level input guards shared by the <c>koine_validate</c>, <c>koine_compile</c>,
/// and <c>koine_format</c> tools. They reject malformed or abusive inputs (no files, blank paths,
/// duplicate paths, oversized payloads) with a stable <c>KOIMCP0xx</c> diagnostic <b>before</b> the
/// compiler runs, so an agent gets an actionable message instead of an opaque crash or a silently
/// dropped file.
/// </summary>
internal static class ToolGuards
{
    /// <summary>The maximum number of <c>.koi</c> files accepted in a single model.</summary>
    internal const int MaxFiles = 256;

    /// <summary>The maximum combined UTF-8 byte length of all source text in a single request (8 MiB).</summary>
    internal const int MaxTotalSourceBytes = 8 * 1024 * 1024;

    /// <summary>
    /// Validates a tool's <paramref name="files"/> array. Returns <c>true</c> with an empty
    /// <paramref name="errors"/> list when the input is well-formed, or <c>false</c> with a
    /// non-empty list of error diagnostics describing every problem found. Checks are ordered so the
    /// null/empty-array guard runs before any per-element iteration.
    /// </summary>
    internal static bool TryValidateFiles(KoineFile[] files, out IReadOnlyList<DiagnosticInfo> errors)
    {
        // (1) no files at all — nothing to validate/compile. `files` is non-null per the nullable
        // annotation, but it is bound from deserialized MCP tool arguments where a JSON `null` can
        // still arrive at runtime, so the guard stays.
        // ReSharper disable once ConditionIsAlwaysTrueOrFalseAccordingToNullableAPIContract
        if (files is null || files.Length == 0)
        {
            errors = new[] { Error("KOIMCP001", "no .koi files were provided") };
            return false;
        }

        var list = new List<DiagnosticInfo>();
        var seenPaths = new HashSet<string>(StringComparer.Ordinal);
        long totalBytes = 0;

        // (2) too many files — reject up front, before scanning each entry.
        if (files.Length > MaxFiles)
        {
            list.Add(Error("KOIMCP004", $"too many files ({files.Length}) — at most {MaxFiles} are accepted in one model"));
        }

        foreach (var file in files)
        {
            // (3) each entry must be a real file with a non-empty path and a (possibly empty) source.
            // `file` / `file.Source` are non-null per the annotations, but they are deserialized from
            // MCP tool arguments where a JSON `null` element or member can still arrive at runtime.
            // ReSharper disable once ConditionIsAlwaysTrueOrFalseAccordingToNullableAPIContract
            if (file is null || string.IsNullOrWhiteSpace(file.Path) || file.Source is null)
            {
                list.Add(Error("KOIMCP002", "each file needs a non-empty path and a (possibly empty) source", file?.Path));
                continue;
            }

            // (4) paths must be unique — a duplicate would silently shadow an earlier file.
            if (!seenPaths.Add(file.Path))
            {
                list.Add(Error("KOIMCP003", $"duplicate file path '{file.Path}' — each file in a model must have a unique path", file.Path));
            }

            totalBytes += Encoding.UTF8.GetByteCount(file.Source);
        }

        // (5) total payload size cap (computed from the valid sources scanned above).
        if (totalBytes > MaxTotalSourceBytes)
        {
            list.Add(Error("KOIMCP005", "input too large (> 8 MiB)"));
        }

        errors = list;
        return list.Count == 0;
    }

    /// <summary>
    /// Validates a single <paramref name="source"/> string for the format tool. An empty string is a
    /// legitimate input (formatting it yields an empty string), so only <c>null</c> or an oversized
    /// payload is rejected. Returns <c>true</c> with a null <paramref name="error"/> when accepted.
    /// </summary>
    internal static bool TryValidateSource(string source, out DiagnosticInfo? error)
    {
        // `source` is non-null per the annotation, but it is bound from a deserialized MCP tool
        // argument where a JSON `null` can still arrive at runtime, so the guard stays.
        // ReSharper disable once ConditionIsAlwaysTrueOrFalseAccordingToNullableAPIContract
        if (source is null)
        {
            error = Error("KOIMCP002", "source must not be null");
            return false;
        }

        if (Encoding.UTF8.GetByteCount(source) > MaxTotalSourceBytes)
        {
            error = Error("KOIMCP005", "input too large (> 8 MiB)");
            return false;
        }

        error = null;
        return true;
    }

    /// <summary>Builds a positionless error diagnostic with the given guard code and message.</summary>
    private static DiagnosticInfo Error(string code, string message, string? file = null) =>
        new("error", code, message, file, 0, 0, 0, 0);
}
