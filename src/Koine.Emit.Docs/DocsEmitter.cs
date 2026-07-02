using System.Text;
using Koine.Compiler.Ast;

namespace Koine.Compiler.Emit.Docs;

/// <summary>
/// Living-documentation emitter: turns the target-agnostic <see cref="KoineModel"/> into
/// Mermaid-in-Markdown documentation that renders on GitHub and Astro Starlight. It consumes
/// ONLY the semantic model (no <c>Emit/CSharp</c> types), proving documentation is a first-class
/// projection of the ubiquitous language.
///
/// <para>Output is deterministic (declaration order, no timestamps) so re-running is byte-identical.
/// One <c>index.md</c> links the whole model; one <c>&lt;Context&gt;.md</c> per bounded context carries
/// the narrative plus inline Mermaid diagrams (state machines, aggregate class diagrams). A single
/// <c>context-map.md</c> and <c>integration-events.md</c> capture the strategic, cross-context views.</para>
///
/// <para>Split across partial classes per diagram type (mirroring the C# emitter house style):
/// <c>.StateMachines.cs</c>, <c>.ContextMap.cs</c>, <c>.Aggregates.cs</c>, <c>.IntegrationEvents.cs</c>,
/// <c>.Narrative.cs</c>.</para>
/// </summary>
public sealed partial class DocsEmitter : IEmitter
{
    public string TargetName => "docs";

    public IReadOnlyList<EmittedFile> Emit(KoineModel model)
    {
        var files = new List<EmittedFile>();

        // One narrative + diagram document per bounded context.
        foreach (ContextNode ctx in model.Contexts)
        {
            var sb = new StringBuilder();
            WriteContextNarrative(sb, ctx);
            files.Add(new EmittedFile($"docs/{ctx.Name}.md", sb.ToString()));
        }

        // The strategic context map (one file), only when a map is declared.
        if (model.ContextMap is not null)
        {
            files.Add(EmitContextMap(model));
        }

        // The cross-context integration-event flow, only when integration events exist.
        files.AddRange(EmitIntegrationEvents(model));

        // The index links everything, last so it can reference the files above.
        files.Add(EmitIndex(model, files));

        return files;
    }

    /// <summary>
    /// Writes the table-of-contents <c>index.md</c>: a link to each context document plus the
    /// strategic views (context map, integration events) when present.
    /// </summary>
    private static EmittedFile EmitIndex(KoineModel model, IReadOnlyList<EmittedFile> emitted)
    {
        var sb = new StringBuilder();
        sb.Append("# Domain Documentation\n");
        sb.Append("\nLiving documentation generated from the Koine model. Each bounded context has its own\n");
        sb.Append("page with the ubiquitous language, aggregates, and Mermaid diagrams of its lifecycles.\n");

        sb.Append("\n## Bounded Contexts\n\n");
        foreach (ContextNode ctx in model.Contexts)
        {
            sb.Append("- [").Append(ctx.Name).Append("](./").Append(ctx.Name).Append(".md)");
            if (ctx.Version is { } version)
            {
                sb.Append(" — version ").Append(version);
            }

            if (!string.IsNullOrEmpty(ctx.Doc))
            {
                sb.Append(" — ").Append(Prose(ctx.Doc));
            }

            sb.Append('\n');
        }

        var hasMap = emitted.Any(f => f.RelativePath == "docs/context-map.md");
        var hasEvents = emitted.Any(f => f.RelativePath == "docs/integration-events.md");
        if (hasMap || hasEvents)
        {
            sb.Append("\n## Strategic Views\n\n");
            if (hasMap)
            {
                sb.Append("- [Context Map](./context-map.md) — the strategic relationships between contexts\n");
            }

            if (hasEvents)
            {
                sb.Append("- [Integration Events](./integration-events.md) — cross-context published-language flows\n");
            }
        }

        return new EmittedFile("docs/index.md", sb.ToString());
    }

    // ---- shared rendering (delegated to Emit/ExprDescriber + Emit/MarkdownDoc) ----
    // Thin forwarders so the partial classes keep their unqualified call sites; the real
    // implementations are shared with GlossaryEmitter to avoid two drifting copies.

    private static string Describe(Expr e) => ExprDescriber.Describe(e);

    private static string KoineType(TypeRef t) => MarkdownDoc.KoineType(t);

    private static string Tag(TypeDecl t) => MarkdownDoc.Tag(t);

    private static void WriteFields(StringBuilder sb, IReadOnlyList<Member> members) =>
        MarkdownDoc.WriteFields(sb, members);

    private static void WriteRules(StringBuilder sb, IReadOnlyList<Invariant> invariants) =>
        MarkdownDoc.WriteRules(sb, invariants);

    private static string EnumValues(EnumDecl en) => MarkdownDoc.EnumValues(en);

    private static string Prose(string text) => MarkdownDoc.Prose(text);
}
