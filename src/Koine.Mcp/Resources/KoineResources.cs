using System.ComponentModel;
using ModelContextProtocol;
using ModelContextProtocol.Server;

namespace Koine.Mcp.Resources;

/// <summary>
/// Exposes the same knowledge as the reference/examples tools as MCP resources, so clients that
/// surface resources can attach them directly. Backed by the shared <see cref="KnowledgeStore"/>.
/// </summary>
[McpServerResourceType]
public static class KoineResources
{
    [McpServerResource(UriTemplate = "koine://reference", Name = "Koine language reference", MimeType = "text/markdown")]
    [Description("The full Koine language reference cheatsheet.")]
    public static string Reference() => KnowledgeStore.ReferenceMarkdown;

    [McpServerResource(UriTemplate = "koine://reference/{topic}", Name = "Koine reference topic", MimeType = "text/markdown")]
    [Description("A single section of the Koine language reference, selected by topic slug.")]
    public static string ReferenceTopic(string topic) =>
        KnowledgeStore.ReferenceSection(topic)
            ?? throw new McpException(
                $"Unknown reference topic '{topic}'. Available: {string.Join(", ", KnowledgeStore.ReferenceTopics)}.");

    [McpServerResource(UriTemplate = "koine://examples/{name}", Name = "Koine example model", MimeType = "text/plain")]
    [Description("A real, compilable Koine example model, selected by name.")]
    public static string Example(string name) =>
        KnowledgeStore.Examples.TryGetValue(name, out var source)
            ? source
            : throw new McpException(
                $"Unknown example '{name}'. Available: {string.Join(", ", KnowledgeStore.Examples.Keys)}.");
}
