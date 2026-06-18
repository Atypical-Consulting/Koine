using Koine.Compiler.Emit;

namespace Koine.Cli.Infrastructure;

/// <summary>
/// Atomic file output for the emitters. Both methods write through a sibling temp path and
/// swap, so a watching consumer never observes an empty or half-written file/folder.
/// </summary>
internal static class OutputWriter
{
    /// <summary>
    /// Writes the emitted files into <paramref name="outDir"/> one owned top-level folder
    /// (namespace root) at a time, swapping each via a sibling temp directory. This avoids
    /// the delete-then-recreate window in which a watching consumer could observe an empty
    /// or partially-written folder, and still drops stale orphans from a previous run.
    /// </summary>
    public static int WriteOutputAtomic(string outDir, IReadOnlyList<EmittedFile> files)
    {
        Directory.CreateDirectory(outDir);

        // Group emitted files by their owned top-level folder (the namespace root).
        var byRoot = files
            .GroupBy(f => f.RelativePath.Replace('\\', '/').Split('/')[0], StringComparer.Ordinal);

        var count = 0;
        foreach (var group in byRoot)
        {
            var root = group.Key;
            var finalDir = Path.Combine(outDir, root);
            var stageDir = Path.Combine(outDir, $".{root}.koine-tmp-{Guid.NewGuid():N}");

            try
            {
                foreach (var emitted in group)
                {
                    // RelativePath starts with `root/…`; re-root it under the staging dir.
                    var relUnderRoot = emitted.RelativePath.Replace('\\', '/')[(root.Length)..].TrimStart('/');
                    var path = Path.Combine(stageDir, relUnderRoot);
                    var dir = Path.GetDirectoryName(path);
                    if (!string.IsNullOrEmpty(dir))
                    {
                        Directory.CreateDirectory(dir);
                    }

                    File.WriteAllText(path, emitted.Contents);
                    count++;
                }

                // Swap: replace the live folder with the fully-written staging folder.
                if (Directory.Exists(finalDir))
                {
                    Directory.Delete(finalDir, recursive: true);
                }

                Directory.Move(stageDir, finalDir);
            }
            finally
            {
                if (Directory.Exists(stageDir))
                {
                    Directory.Delete(stageDir, recursive: true);
                }
            }
        }

        return count;
    }

    /// <summary>Writes a single file atomically via a temp file + replace, so readers never see a half-written file.</summary>
    public static void WriteFileAtomic(string path, string contents)
    {
        var tmp = path + $".koine-tmp-{Guid.NewGuid():N}";
        File.WriteAllText(tmp, contents);
        if (File.Exists(path))
        {
            File.Delete(path);
        }

        File.Move(tmp, path);
    }
}
