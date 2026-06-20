using System.ComponentModel;
using ModelContextProtocol.Server;

namespace Koine.Mcp.Tools;

/// <summary>The <c>koine_examples</c> tool: real, compilable example models.</summary>
[McpServerToolType]
public static class ExamplesTool
{
    [McpServerTool(Name = "koine_examples")]
    [Description("""
        Get real, compilable Koine (.koi) example models to learn the syntax and idioms. Call with no
        name to list the available examples; pass a name to get that file's full source. Includes a
        small single-context example ("billing") and a six-context Pizzeria domain ("pizzeria-menu",
        "pizzeria-ordering", "pizzeria-kitchen", "pizzeria-delivery", "pizzeria-payment",
        "pizzeria-promotions", "pizzeria-context-map") that together exercise commands, events,
        state machines, factories, repositories, services, read models, queries, integration
        events, and context maps.
        """)]
    public static string Examples(
        [Description("Optional example name. Omit to list all available example names.")]
        string? name = null)
    {
        if (string.IsNullOrWhiteSpace(name))
        {
            return KnowledgeStore.ExamplesListing();
        }

        return KnowledgeStore.Examples.TryGetValue(name, out var source)
            ? source
            : KnowledgeStore.UnknownExampleMessage(name);
    }
}
