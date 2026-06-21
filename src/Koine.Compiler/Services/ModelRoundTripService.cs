using System.Text;
using Koine.Compiler.Ast;
using Koine.Compiler.Emit;

namespace Koine.Compiler.Services;

/// <summary>
/// The target-agnostic <b>model→<c>.koi</c> round-trip seam</b> (#91): the single, validated
/// foundation every Koine Studio visual editor (interactive context map, state-machine editor,
/// guided domain builder, drag-to-edit diagrams) builds on, surfaced identically over the desktop
/// LSP and the browser WASM host. It generalises the narrow <c>koine/glossaryModel</c> precedent —
/// which only round-trips glossary descriptions — to the whole model graph, with four capabilities:
///
/// <list type="number">
///   <item><description><see cref="ModelToJson"/> — serialise the compiled <see cref="KoineModel"/>
///   (or a scoped subtree by qualified name) to the stable <see cref="ModelNode"/> contract an editor
///   drives forms/canvases from.</description></item>
///   <item><description><see cref="MembersOf"/> — enumerate a node's editable children (a value/
///   entity's fields, an enum's members, a state machine's transitions) with kinds + current values,
///   so an editor builds a form without re-parsing.</description></item>
///   <item><description><see cref="EmitKoine"/> — apply a structured edit, <b>validate</b> the
///   resulting model (reuse <see cref="Semantics.SemanticValidator"/>), and on success re-emit the canonical
///   <c>.koi</c> for just the affected declaration via <see cref="Formatting.AstPrinter"/>. An illegal
///   edit returns the <c>KOIxxxx</c> diagnostics instead of broken <c>.koi</c>.</description></item>
///   <item><description><see cref="ApplyEdit"/> — return a span-minimal
///   <see cref="TextEditModel"/> over just the touched declaration (reusing the
///   <see cref="RefactorService"/> edit model) so the client patches the buffer without reflowing the
///   file, preserving surrounding formatting and comments.</description></item>
/// </list>
///
/// <para>Purely target-agnostic: it composes <see cref="Formatting.AstPrinter"/>,
/// <see cref="Semantics.SemanticValidator"/>, and the parser, leaks no C# concept into <c>Ast/</c>, and lives in
/// <c>Services/</c> beside the other editor backends.</para>
/// </summary>
public static partial class ModelRoundTripService
{
    /// <summary>The stable qualified name of the synthetic context-map node under the model root.</summary>
    public const string ContextMapQualifiedName = "$contextMap";

    // ---- Read paths -------------------------------------------------------

    /// <summary>
    /// Projects <paramref name="model"/> into the stable <see cref="ModelNode"/> tree (#91). With no
    /// <paramref name="qualifiedName"/> the synthetic <c>model</c> root is returned, its
    /// <see cref="ModelNode.Children"/> the bounded contexts (then the strategic context map, when
    /// present) in declaration order. With a qualified name only the matching subtree is returned —
    /// the scoped read an editor uses to drive a single form/canvas — or an empty <c>unknown</c> node
    /// when nothing resolves. Declaration-order stable, so editors never reshuffle.
    /// </summary>
    public static ModelNode ModelToJson(KoineModel model, string? qualifiedName = null)
    {
        ModelNode root = BuildRoot(model);
        if (string.IsNullOrEmpty(qualifiedName))
        {
            return root;
        }

        return Find(root, qualifiedName) ?? new ModelNode("unknown", qualifiedName, qualifiedName, [], []);
    }

    /// <summary>
    /// Enumerates the editable children (<see cref="ModelNode.Members"/>) of the node addressed by
    /// <paramref name="qualifiedName"/> — a value/entity's fields, an enum's members, a state machine's
    /// transitions, the context map's relations — with their kinds and current values. Empty when the
    /// name does not resolve. Declaration-order stable.
    /// </summary>
    public static IReadOnlyList<ModelMember> MembersOf(KoineModel model, string qualifiedName) =>
        Find(BuildRoot(model), qualifiedName)?.Members ?? [];

    /// <summary>Builds the synthetic <c>model</c> root: one child per context, then the context map.</summary>
    private static ModelNode BuildRoot(KoineModel model)
    {
        var children = new List<ModelNode>();
        foreach (ContextNode ctx in model.Contexts)
        {
            children.Add(BuildContext(ctx));
        }

        if (model.ContextMap is { } map && map.Relations.Count > 0)
        {
            children.Add(BuildContextMap(map));
        }

        return new ModelNode("model", "", "", [], children);
    }

    private static ModelNode BuildContext(ContextNode ctx)
    {
        var children = new List<ModelNode>();
        foreach (TypeDecl type in ctx.Types)
        {
            children.Add(BuildType(type, ctx.Name));
        }

        return new ModelNode("context", ctx.Name, ctx.Name, [], children);
    }

    private static ModelNode BuildType(TypeDecl type, string prefix)
    {
        var qualified = prefix + "." + type.Name;
        return type switch
        {
            AggregateDecl agg => new ModelNode(
                "aggregate", qualified, agg.Name, [],
                agg.Types.Select(t => BuildType(t, qualified)).ToList()),

            EntityDecl entity => new ModelNode(
                "entity", qualified, entity.Name,
                entity.Members.Select(FieldMember).ToList(),
                entity.States.Select(s => BuildStates(s, qualified)).ToList()),

            ValueObjectDecl vo => new ModelNode(
                vo.IsQuantity ? "quantity" : "value", qualified, vo.Name,
                vo.Members.Select(FieldMember).ToList(), []),

            EnumDecl en => new ModelNode(
                "enum", qualified, en.Name,
                en.Members.Select(EnumMemberOf).ToList(), []),

            EventDecl ev => new ModelNode(
                "event", qualified, ev.Name,
                ev.Members.Select(FieldMember).ToList(), []),

            IntegrationEventDecl ie => new ModelNode(
                "integration event", qualified, ie.Name,
                ie.Members.Select(FieldMember).ToList(), []),

            _ => new ModelNode("type", qualified, type.Name, [], []),
        };
    }

    private static ModelNode BuildStates(StatesDecl states, string entityQualified)
    {
        var qualified = entityQualified + ".states." + states.Field;
        var transitions = states.Rules
            .Select(r => new ModelMember(
                "transition",
                r.From,
                r.Guard is null ? null : ExprDescriber.Describe(r.Guard),
                string.Join(", ", r.To)))
            .ToList();
        return new ModelNode("states", qualified, states.Field, transitions, []);
    }

    private static ModelNode BuildContextMap(ContextMapNode map)
    {
        var relations = map.Relations
            .Select(r => new ModelMember(
                "relation",
                $"{r.Upstream} {(r.IsBidirectional ? "<->" : "->")} {r.Downstream}",
                RelationRole(r.Kind),
                RelationDetail(r)))
            .ToList();
        return new ModelNode("contextMap", ContextMapQualifiedName, "Context Map", relations, []);
    }

    private static ModelMember FieldMember(Member m) => new(
        "field", m.Name, FormatType(m.Type),
        m.Initializer is null ? null : ExprDescriber.Describe(m.Initializer));

    private static ModelMember EnumMemberOf(EnumMember em) => new(
        "enumMember", em.Name, null,
        em.Args.Count == 0 ? null : string.Join(", ", em.Args.Select(ExprDescriber.Describe)));

    private static string? RelationDetail(ContextRelation r)
    {
        if (r.SharedTypes.Count > 0)
        {
            return string.Join(", ", r.SharedTypes);
        }

        if (r.AclMappings.Count > 0)
        {
            return string.Join(", ", r.AclMappings.Select(a =>
                $"{a.UpstreamContext}.{a.UpstreamType} -> {a.LocalContext}.{a.LocalType}"));
        }

        return null;
    }

    private static string RelationRole(ContextRelationKind kind) => kind switch
    {
        ContextRelationKind.Partnership => "partnership",
        ContextRelationKind.SharedKernel => "shared kernel",
        ContextRelationKind.CustomerSupplier => "customer/supplier",
        ContextRelationKind.Conformist => "conformist",
        ContextRelationKind.AntiCorruptionLayer => "anti-corruption layer",
        ContextRelationKind.OpenHost => "open host service",
        ContextRelationKind.PublishedLanguage => "published language",
        _ => kind.ToString(),
    };

    /// <summary>Renders a <see cref="TypeRef"/> in canonical <c>.koi</c> syntax (generics, optionality, qualifier).</summary>
    private static string FormatType(TypeRef t)
    {
        var sb = new StringBuilder();
        if (t.Qualifier is not null)
        {
            sb.Append(t.Qualifier).Append('.');
        }

        sb.Append(t.Name);
        if (t.Element is not null)
        {
            sb.Append('<').Append(FormatType(t.Element));
            if (t.Value is not null)
            {
                sb.Append(", ").Append(FormatType(t.Value));
            }

            sb.Append('>');
        }

        if (t.IsOptional)
        {
            sb.Append('?');
        }

        return sb.ToString();
    }

    /// <summary>Depth-first search for the node whose <see cref="ModelNode.QualifiedName"/> matches.</summary>
    private static ModelNode? Find(ModelNode node, string qualifiedName)
    {
        if (string.Equals(node.QualifiedName, qualifiedName, StringComparison.Ordinal))
        {
            return node;
        }

        foreach (ModelNode child in node.Children)
        {
            if (Find(child, qualifiedName) is { } hit)
            {
                return hit;
            }
        }

        return null;
    }
}
