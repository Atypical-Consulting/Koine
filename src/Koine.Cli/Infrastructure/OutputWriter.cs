using System.Text;
using System.Text.Json;
using Koine.Compiler.Emit;

namespace Koine.Cli.Infrastructure;

/// <summary>
/// Atomic file output for the emitters. Both methods write through a sibling temp path and
/// swap, so a watching consumer never observes an empty or half-written file/folder.
/// </summary>
/// <remarks>
/// Output is pinned to <b>UTF-8 with no byte-order mark</b> and <c>\n</c> (LF) line endings,
/// independent of the host OS. Any <c>\r</c> carried in emitter content is normalized to
/// <c>\n</c> before writing, so identical input always produces byte-identical files (stable
/// diffs, hashing, and snapshots regardless of platform).
/// </remarks>
internal static class OutputWriter
{
    /// <summary>UTF-8 without a BOM. Shared so every write uses the exact same, deterministic encoding.</summary>
    private static readonly UTF8Encoding Utf8NoBom = new(encoderShouldEmitUTF8Identifier: false);

    /// <summary>
    /// File name of the sidecar manifest recording the top-level roots written into an output
    /// directory. Leading dot keeps it out of the compiled source glob; it is never treated as a root.
    /// </summary>
    private const string ManifestFileName = ".koine-output.json";

    /// <summary>Indented JSON, case-insensitive on read, so the manifest is human-readable and forgiving.</summary>
    private static readonly JsonSerializerOptions ManifestJsonOptions = new()
    {
        WriteIndented = true,
        PropertyNameCaseInsensitive = true,
    };

    /// <summary>Normalizes CRLF/CR line endings to LF so output stays byte-stable across platforms.</summary>
    private static string NormalizeLineEndings(string contents)
        => contents.Replace("\r\n", "\n").Replace('\r', '\n');
    /// <summary>
    /// Writes the emitted files into <paramref name="outDir"/> one owned top-level folder
    /// (namespace root) at a time, swapping each via a sibling temp directory. This avoids
    /// the delete-then-recreate window in which a watching consumer could observe an empty
    /// or partially-written folder. After writing, the emitted roots are reconciled against
    /// the previous run recorded in a sidecar <c>.koine-output.json</c> manifest: any top-level
    /// root the manifest recorded but this run no longer emits is pruned, so a removed or renamed
    /// bounded context leaves no dead folder behind. Pruning is scoped to roots Koine itself
    /// recorded — folders dropped into <paramref name="outDir"/> by hand are never touched.
    /// </summary>
    public static int WriteOutputAtomic(string outDir, IReadOnlyList<EmittedFile> files)
    {
        Directory.CreateDirectory(outDir);

        // Group emitted files by their owned top-level folder (the namespace root).
        var byRoot = files
            .GroupBy(f => f.RelativePath.Replace('\\', '/').Split('/')[0], StringComparer.Ordinal);

        var count = 0;
        var emittedRoots = new HashSet<string>(StringComparer.Ordinal);
        foreach (var group in byRoot)
        {
            var root = group.Key;
            emittedRoots.Add(root);
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

                    File.WriteAllText(path, NormalizeLineEndings(emitted.Contents), Utf8NoBom);
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

        // Reconcile against the previous run: prune whole top-level roots that this model no
        // longer emits. Only roots recorded in our own manifest are eligible, so files a user
        // dropped into outDir by hand are never deleted.
        var manifestPath = Path.Combine(outDir, ManifestFileName);
        foreach (var stale in ReadManifestRoots(manifestPath).Where(root => !emittedRoots.Contains(root)))
        {
            var staleDir = Path.Combine(outDir, stale);
            if (Directory.Exists(staleDir))
            {
                Directory.Delete(staleDir, recursive: true);
            }
        }

        WriteManifest(manifestPath, emittedRoots);

        return count;
    }

    /// <summary>The on-disk shape of the sidecar manifest: the top-level roots a run wrote.</summary>
    private sealed record OutputManifest(IReadOnlyList<string> Roots);

    /// <summary>
    /// Reads the roots recorded by the previous run, or an empty set if there is no manifest. A
    /// missing or unreadable manifest yields no roots — we never delete a root we cannot prove we
    /// wrote, so a corrupt manifest simply skips pruning rather than risking a wrong delete.
    /// </summary>
    private static IReadOnlyList<string> ReadManifestRoots(string manifestPath)
    {
        if (!File.Exists(manifestPath))
        {
            return [];
        }

        try
        {
            var manifest = JsonSerializer.Deserialize<OutputManifest>(File.ReadAllText(manifestPath), ManifestJsonOptions);
            return manifest?.Roots ?? [];
        }
        catch (JsonException)
        {
            return [];
        }
    }

    /// <summary>
    /// Writes the manifest of roots emitted this run, ordinally sorted so identical models produce
    /// byte-identical manifests, via the same atomic helper so it is never observed half-written.
    /// </summary>
    private static void WriteManifest(string manifestPath, IEnumerable<string> roots)
    {
        var ordered = roots.OrderBy(root => root, StringComparer.Ordinal).ToArray();
        WriteFileAtomic(manifestPath, JsonSerializer.Serialize(new OutputManifest(ordered), ManifestJsonOptions));
    }

    /// <summary>Writes a single file atomically via a temp file + replace, so readers never see a half-written file.</summary>
    public static void WriteFileAtomic(string path, string contents)
    {
        var tmp = path + $".koine-tmp-{Guid.NewGuid():N}";
        File.WriteAllText(tmp, NormalizeLineEndings(contents), Utf8NoBom);
        if (File.Exists(path))
        {
            File.Delete(path);
        }

        File.Move(tmp, path);
    }
}
