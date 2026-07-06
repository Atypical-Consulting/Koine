using System.Text;
using Koine.Compiler.Ast;
using Koine.Compiler.Services;

namespace Koine.Compiler;

/// <summary>
/// Context-scoped class diagram (the bounded context's domain model): a single Mermaid
/// <c>classDiagram</c> with a class node for EVERY drawable type the context declares — its standalone
/// value objects, enums, entities and events PLUS the types nested inside its aggregates (the aggregate
/// root carries the <c>&lt;&lt;aggregate root&gt;&gt;</c> stereotype) — and an edge for every field that
/// references another in-context type: a composition (<c>*--</c>) for an owned part, an association
/// (<c>--&gt;</c>) for a by-id reference to another entity. This replaces the older per-aggregate class diagram so
/// the diagram reads as the whole context (e.g. a free-standing <c>Money</c>/<c>Email</c> value object
/// shows up, not just the types nested under one aggregate).
///
/// <para>The node/edge set is computed ONCE by <see cref="ContextClassModel"/> and consumed by both the
/// Markdown emitter (<see cref="EmitContextClassDiagram"/>) and the structured-graph builder
/// (<c>BuildContextDescriptor</c> in <c>.Diagrams.cs</c>), so the two never drift — the same lock-step
/// the aggregate diagram had.</para>
/// </summary>
public sealed partial class DocsEmitter
{
    /// <summary>A class node drawn in a context diagram: the declaration, its node kind + stereotype, and
    /// (for an aggregate root) the owning aggregate so its class body includes identity/commands/factories.</summary>
    internal sealed record ContextClassNode(TypeDecl Type, string Kind, string Stereotype, AggregateDecl? OwningAggregate);

    /// <summary>An edge source → target with the target multiplicity and the backing field (so a visual
    /// editor can disconnect the edge by removing that field). <paramref name="ArrowKind"/> is
    /// <c>"composition"</c> when the field names the target type directly (the owner contains the part,
    /// drawn <c>*--</c>) or <c>"association"</c> when it names an entity target's identity type — a by-id
    /// reference across the boundary (drawn <c>--&gt;</c>), the DDD "reference other aggregates by id" rule.</summary>
    internal sealed record ContextClassEdge(string From, string To, string? Cardinality, string? BackingMember, string ArrowKind);

    /// <summary>
    /// The drawn nodes (declaration order, deduped by simple name) and edges of a context's class diagram
    /// — the single source of truth both the Mermaid and structured-graph paths walk. A type is drawn
    /// when it has a node kind (value object / enum / event / entity); aggregate containers and
    /// integration events are not nodes. An edge is added for every field whose type (or collection
    /// element/value) names another drawn type — or that type's identity type, for a by-id reference to
    /// an entity — deduped to one edge per source→target pair.
    /// </summary>
    internal static (IReadOnlyList<ContextClassNode> Nodes, IReadOnlyList<ContextClassEdge> Edges) ContextClassModel(ContextNode ctx)
    {
        // Which entities are aggregate roots (and their owning aggregate), so they draw stereotyped and
        // their class body is rendered with the aggregate's identity/command/factory rows.
        var roots = new Dictionary<EntityDecl, AggregateDecl>(ReferenceEqualityComparer.Instance);
        foreach (AggregateDecl agg in ctx.AllTypeDecls().OfType<AggregateDecl>())
        {
            if (agg.RootEntity() is { } root)
            {
                roots[root] = agg;
            }
        }

        var nodes = new List<ContextClassNode>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (TypeDecl t in ctx.AllTypeDecls())
        {
            if (t is AggregateDecl)
            {
                continue; // a container, represented by its root entity node
            }

            string? stereotype;
            string? kind;
            if (t is EntityDecl entity && roots.ContainsKey(entity))
            {
                stereotype = "aggregate root";
                kind = "aggregate-root";
            }
            else
            {
                stereotype = NestedStereotype(t);
                kind = NestedKind(t);
            }

            if (stereotype is null || kind is null)
            {
                continue; // integration events / nested aggregates are not drawn as class nodes
            }

            if (!seen.Add(t.Name))
            {
                continue; // dedupe by simple name (the node id), first declaration wins
            }

            AggregateDecl? owner = t is EntityDecl re && roots.TryGetValue(re, out var a) ? a : null;
            nodes.Add(new ContextClassNode(t, kind, stereotype, owner));
        }

        var edges = new List<ContextClassEdge>();
        var edgeSeen = new HashSet<string>(StringComparer.Ordinal);
        foreach (ContextClassNode node in nodes)
        {
            foreach (Member m in node.Type.MembersOf())
            {
                foreach (ContextClassNode target in nodes)
                {
                    if (ReferenceEquals(target, node))
                    {
                        continue;
                    }

                    var relation = EdgeTo(m.Type, target);
                    if (relation is null)
                    {
                        continue;
                    }

                    // One edge per source→target pair (the first referencing field backs it), so two fields
                    // of the same type don't draw parallel edges.
                    if (!edgeSeen.Add($"{node.Type.Name}->{target.Type.Name}"))
                    {
                        continue;
                    }

                    edges.Add(new ContextClassEdge(
                        node.Type.Name, target.Type.Name, relation.Value.Cardinality,
                        $"{ctx.Name}.{node.Type.Name}.{m.Name}", relation.Value.ArrowKind));
                }
            }
        }

        return (nodes, edges);
    }

    /// <summary>Writes the context's domain-model class diagram (the fenced Mermaid block) — empty when the
    /// context declares no drawable type. The exact block is also carried on the structured descriptor.</summary>
    private static void EmitContextClassDiagram(StringBuilder sb, ContextNode ctx)
    {
        var (nodes, edges) = ContextClassModel(ctx);
        if (nodes.Count == 0)
        {
            return;
        }

        sb.Append("\n```mermaid\nclassDiagram\n");
        foreach (ContextClassNode node in nodes)
        {
            if (node.Kind == "aggregate-root" && node.OwningAggregate is { } agg && node.Type is EntityDecl root)
            {
                EmitRootClass(sb, agg, root);
            }
            else
            {
                EmitNestedClass(sb, node.Type);
            }
        }

        foreach (ContextClassEdge edge in edges)
        {
            // *-- (filled diamond) for an owned composition; --> (open arrow) for a by-id association.
            string arrow = edge.ArrowKind == "association" ? " --> " : " *-- ";
            sb.Append("    ").Append(edge.From).Append(arrow).Append(edge.To).Append('\n');
        }

        sb.Append("```\n");
    }

    /// <summary>
    /// How a field typed <paramref name="t"/> relates to the node <paramref name="target"/>, or
    /// <c>null</c> when it doesn't reference it. A field naming the target type directly is a composition
    /// (the owner contains the part); a field naming an entity target's identity type (e.g.
    /// <c>customer: CustomerId</c> → the <c>Customer</c> entity) is an association — holding another
    /// aggregate's id is a reference, not ownership. The cardinality is the target-end multiplicity:
    /// a collection (<c>List/Set/Map&lt;…X…&gt;</c>) → <c>"*"</c>, an optional field (<c>X?</c>) →
    /// <c>"0..1"</c>, a plain field → <c>"1"</c>.
    /// </summary>
    private static (string Cardinality, string ArrowKind)? EdgeTo(TypeRef t, ContextClassNode target)
    {
        if (EdgeCardinality(t, target.Type.Name) is { } byType)
        {
            return (byType, "composition");
        }

        if (target.Type is EntityDecl e
            && !string.Equals(e.IdentityName, target.Type.Name, StringComparison.Ordinal)
            && EdgeCardinality(t, e.IdentityName) is { } byId)
        {
            return (byId, "association");
        }

        return null;
    }

    /// <summary>
    /// The target-end multiplicity of a reference from a field typed <paramref name="t"/> to the type
    /// named <paramref name="targetName"/>: a collection (<c>List/Set/Map&lt;…X…&gt;</c>) → <c>"*"</c>, an
    /// optional field (<c>X?</c>) → <c>"0..1"</c>, a plain field → <c>"1"</c>; <c>null</c> when the field
    /// does not reference that type.
    /// </summary>
    private static string? EdgeCardinality(TypeRef t, string targetName)
    {
        if (string.Equals(t.Name, targetName, StringComparison.Ordinal))
        {
            return t.IsOptional ? "0..1" : "1";
        }

        return ReferencesAsTypeArgument(t, targetName) ? "*" : null;
    }
}
