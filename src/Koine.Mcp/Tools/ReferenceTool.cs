using System.ComponentModel;
using ModelContextProtocol.Server;

namespace Koine.Mcp.Tools;

/// <summary>The <c>koine_reference</c> tool: the Koine language cheatsheet, whole or by topic.</summary>
[McpServerToolType]
public static class ReferenceTool
{
    [McpServerTool(Name = "koine_reference")]
    [Description("""
        Get the Koine language reference: a compact cheatsheet of every construct (value, entity,
        aggregate, enum, command, event, state machine, factory, repository, service, readmodel,
        query, spec, policy, integration event, module, import, context map), the type system, and
        the expression/invariant sublanguage. Call with no topic for the full reference plus the list
        of available topics; pass a topic slug (e.g. "value", "aggregate", "expressions",
        "context-map") to get just that section. Read this before authoring .koi when you are unsure
        of the syntax.
        """)]
    public static string Reference(
        [Description("Optional topic slug to narrow the reference. Omit for the whole document.")]
        string? topic = null)
    {
        if (string.IsNullOrWhiteSpace(topic))
        {
            return KnowledgeStore.ReferenceMarkdown;
        }

        return KnowledgeStore.ReferenceSection(topic)
            ?? $"Unknown topic '{topic}'. Available topics: {string.Join(", ", KnowledgeStore.ReferenceTopics)}.";
    }
}
