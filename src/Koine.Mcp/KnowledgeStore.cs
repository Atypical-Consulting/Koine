using System.Collections.Immutable;
using System.Reflection;
using System.Text;

namespace Koine.Mcp;

/// <summary>
/// Reads the agent-facing knowledge embedded in this assembly: the Koine language reference
/// cheatsheet and the real example models (see the <c>EmbeddedResource</c> entries in
/// <c>Koine.Mcp.csproj</c>). It is the single backing store shared by the reference/examples tools
/// and the matching MCP resources, so there is one source of truth.
/// </summary>
internal static class KnowledgeStore
{
    private static readonly Assembly Asm = typeof(KnowledgeStore).Assembly;

    private const string ReferenceResource = "koine.reference.md";
    private const string ExamplePrefix = "koine.examples.";
    private const string ExampleSuffix = ".koi";
    private const string TopicMarker = "<!-- topic:";

    /// <summary>The full Koine language reference (Markdown).</summary>
    public static string ReferenceMarkdown { get; } = ReadResource(ReferenceResource);

    /// <summary>Example name (e.g. <c>billing</c>, <c>pizzeria-ordering</c>) → its <c>.koi</c> source.</summary>
    public static ImmutableSortedDictionary<string, string> Examples { get; } = LoadExamples();

    /// <summary>The topic slugs defined in the reference, in document order.</summary>
    public static IReadOnlyList<string> ReferenceTopics { get; } = ParseTopics(ReferenceMarkdown);

    /// <summary>
    /// Returns the reference section for <paramref name="topic"/> (case-insensitive), or
    /// <c>null</c> when the topic is unknown. Sections are delimited by
    /// <c>&lt;!-- topic: slug --&gt;</c> markers in <c>reference.md</c>.
    /// </summary>
    public static string? ReferenceSection(string topic)
    {
        var capturing = false;
        var sb = new StringBuilder();

        foreach (var line in SplitLines(ReferenceMarkdown))
        {
            var marker = TopicOf(line);
            if (marker is not null)
            {
                if (capturing)
                {
                    break; // reached the next section
                }

                if (string.Equals(marker, topic, StringComparison.OrdinalIgnoreCase))
                {
                    capturing = true;
                }

                continue; // never echo the marker line itself
            }

            if (capturing)
            {
                sb.Append(line).Append('\n');
            }
        }

        return capturing ? sb.ToString().Trim() : null;
    }

    private static ImmutableSortedDictionary<string, string> LoadExamples()
    {
        var builder = ImmutableSortedDictionary.CreateBuilder<string, string>(StringComparer.Ordinal);
        foreach (var name in Asm.GetManifestResourceNames())
        {
            if (name.StartsWith(ExamplePrefix, StringComparison.Ordinal) &&
                name.EndsWith(ExampleSuffix, StringComparison.Ordinal))
            {
                var key = name[ExamplePrefix.Length..^ExampleSuffix.Length];
                builder[key] = ReadResource(name);
            }
        }

        return builder.ToImmutable();
    }

    private static IReadOnlyList<string> ParseTopics(string markdown)
    {
        var topics = new List<string>();
        foreach (var line in SplitLines(markdown))
        {
            var topic = TopicOf(line);
            if (topic is not null)
            {
                topics.Add(topic);
            }
        }

        return topics;
    }

    /// <summary>Extracts the slug from a <c>&lt;!-- topic: slug --&gt;</c> line, or null if not one.</summary>
    private static string? TopicOf(string line)
    {
        var trimmed = line.Trim();
        if (!trimmed.StartsWith(TopicMarker, StringComparison.Ordinal))
        {
            return null;
        }

        var end = trimmed.IndexOf("-->", TopicMarker.Length, StringComparison.Ordinal);
        return end < 0 ? null : trimmed[TopicMarker.Length..end].Trim();
    }

    private static IEnumerable<string> SplitLines(string text) =>
        text.Replace("\r\n", "\n").Split('\n');

    private static string ReadResource(string logicalName)
    {
        using var stream = Asm.GetManifestResourceStream(logicalName)
            ?? throw new InvalidOperationException($"embedded knowledge resource not found: {logicalName}");
        using var reader = new StreamReader(stream);
        return reader.ReadToEnd();
    }
}
