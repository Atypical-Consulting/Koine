using System.Text;
using Koine.Compiler.Ast;
using Koine.Compiler.Emit;

namespace Koine.Compiler;

/// <summary>
/// Context-map slice of <see cref="DocsEmitter"/>: the strategic DDD map as a Mermaid <c>flowchart LR</c>.
/// One node per context (declared alphabetically for stability), one edge per relation in source order.
/// Bidirectional relations use <c>&lt;--&gt;</c>; anti-corruption layers use a dotted edge. Shared-kernel
/// types and ACL mappings are listed as notes beneath the diagram.
/// </summary>
public sealed partial class DocsEmitter
{
    /// <summary>Emits <c>context-map.md</c> for a model that declares a context map.</summary>
    private static EmittedFile EmitContextMap(KoineModel model)
    {
        var sb = new StringBuilder();
        sb.Append("# Context Map\n");
        sb.Append("\nThe strategic relationships between the bounded contexts of this domain.\n");

        var relations = model.ContextMap!.Relations;

        sb.Append("\n```mermaid\nflowchart LR\n");

        // Declare every referenced context as a node (alphabetical for deterministic output).
        var contexts = new SortedSet<string>(StringComparer.Ordinal);
        foreach (ContextRelation rel in relations)
        {
            contexts.Add(rel.Upstream);
            contexts.Add(rel.Downstream);
        }

        foreach (string ctx in contexts)
        {
            // The node id must be a bare Mermaid identifier; the display label stays the raw, quoted name.
            sb.Append("    ").Append(Sanitize(ctx)).Append("[\"").Append(ctx).Append("\"]\n");
        }

        if (contexts.Count > 0)
        {
            sb.Append('\n');
        }

        foreach (ContextRelation rel in relations)
        {
            EmitRelationEdge(sb, rel);
        }

        sb.Append("```\n");

        WriteSharedKernels(sb, relations);
        WriteAntiCorruptionLayers(sb, relations);
        WriteRelationLegend(sb, relations);

        return new EmittedFile("docs/context-map.md", sb.ToString());
    }

    /// <summary>Emits one Mermaid edge for a relation, with a human-readable kind label.</summary>
    private static void EmitRelationEdge(StringBuilder sb, ContextRelation rel)
    {
        var label = KindLabel(rel.Kind);

        var upstream = Sanitize(rel.Upstream);
        var downstream = Sanitize(rel.Downstream);

        if (rel.Kind == ContextRelationKind.AntiCorruptionLayer)
        {
            // Dotted edge for an anti-corruption layer.
            sb.Append("    ").Append(upstream).Append(" -.->|").Append(label).Append("| ")
              .Append(downstream).Append('\n');
            return;
        }

        var arrow = rel.IsBidirectional ? "<-->" : "-->";
        sb.Append("    ").Append(upstream).Append(' ').Append(arrow).Append("|").Append(label).Append("| ")
          .Append(downstream).Append('\n');
    }

    private static void WriteSharedKernels(StringBuilder sb, IReadOnlyList<ContextRelation> relations)
    {
        var shared = relations.Where(r => r.SharedTypes.Count > 0).ToList();
        if (shared.Count == 0)
        {
            return;
        }

        sb.Append("\n## Shared Kernels\n\n");
        foreach (ContextRelation rel in shared)
        {
            sb.Append("- **").Append(rel.Upstream).Append(" & ").Append(rel.Downstream).Append("** — shared types: ")
              .Append(string.Join(", ", rel.SharedTypes.Select(t => "`" + t + "`"))).Append('\n');
        }
    }

    private static void WriteAntiCorruptionLayers(StringBuilder sb, IReadOnlyList<ContextRelation> relations)
    {
        var acls = relations.Where(r => r.AclMappings.Count > 0).ToList();
        if (acls.Count == 0)
        {
            return;
        }

        sb.Append("\n## Anti-Corruption Layers\n\n");
        foreach (ContextRelation rel in acls)
        {
            sb.Append("- **").Append(rel.Upstream).Append(" -> ").Append(rel.Downstream).Append("**\n");
            foreach (AclMapping map in rel.AclMappings)
            {
                sb.Append("  - `").Append(map.UpstreamContext).Append('.').Append(map.UpstreamType)
                  .Append("` -> `").Append(map.LocalContext).Append('.').Append(map.LocalType).Append("`\n");
            }
        }
    }

    /// <summary>Lists each relation with its direction and kind, for an at-a-glance reference.</summary>
    private static void WriteRelationLegend(StringBuilder sb, IReadOnlyList<ContextRelation> relations)
    {
        if (relations.Count == 0)
        {
            return;
        }

        sb.Append("\n## Relationships\n\n");
        foreach (ContextRelation rel in relations)
        {
            var arrow = rel.IsBidirectional ? "<->" : "->";
            sb.Append("- `").Append(rel.Upstream).Append(' ').Append(arrow).Append(' ').Append(rel.Downstream)
              .Append("` — ").Append(KindLabel(rel.Kind)).Append('\n');
        }
    }

    /// <summary>Maps a relation kind to a human-readable label.</summary>
    private static string KindLabel(ContextRelationKind kind) => kind switch
    {
        ContextRelationKind.Partnership => "Partnership",
        ContextRelationKind.SharedKernel => "Shared Kernel",
        ContextRelationKind.CustomerSupplier => "Customer-Supplier",
        ContextRelationKind.Conformist => "Conformist",
        ContextRelationKind.AntiCorruptionLayer => "ACL",
        ContextRelationKind.OpenHost => "Open Host",
        ContextRelationKind.PublishedLanguage => "Published Language",
        _ => "?"
    };
}
