using System.Text;
using Koine.Compiler.Ast;

namespace Koine.Compiler;

/// <summary>
/// Aggregate slice of <see cref="DocsEmitter"/>: the class-node renderers (the root entity stereotyped
/// <c>&lt;&lt;aggregate root&gt;&gt;</c> with its concrete fields and command/factory methods, and each
/// other type) plus the repository finders/operations reference block. The class nodes are assembled
/// into a single per-context class diagram by <see cref="EmitContextClassDiagram"/>; this file owns how
/// one class draws. Derived (computed) members use UML derived-attribute notation (<c>/name</c>);
/// declaration order is preserved.
/// </summary>
public sealed partial class DocsEmitter
{
    /// <summary>Writes the aggregate's repository reference block (finders + operations), if any.</summary>
    private static void EmitRepositorySurface(StringBuilder sb, AggregateDecl agg)
    {
        if (agg.Repository?.Finders is { Count: > 0 } finders)
        {
            sb.Append("\n**Repository finders:**\n");
            foreach (FinderDecl finder in finders)
            {
                sb.Append("- `").Append(finder.Name).Append('(')
                  .Append(string.Join(", ", finder.Parameters.Select(p => $"{p.Name}: {KoineType(p.Type)}")))
                  .Append("): ").Append(KoineType(finder.ResultType)).Append("`\n");
            }
        }

        if (agg.Repository?.Operations is { Count: > 0 } ops)
        {
            sb.Append("\n**Repository operations:** ")
              .Append(string.Join(", ", ops.Select(o => "`" + o + "`"))).Append('\n');
        }
    }

    /// <summary>Emits the root entity class: stereotype, identity, concrete fields, commands, factories.</summary>
    private static void EmitRootClass(StringBuilder sb, AggregateDecl agg, EntityDecl root)
    {
        sb.Append("    class ").Append(root.Name).Append(" {\n");
        sb.Append("        <<aggregate root>>\n");
        EmitClassRows(sb, ClassRows(root, agg));
        sb.Append("    }\n");
    }

    /// <summary>Emits a nested type's class declaration with the appropriate stereotype.</summary>
    private static void EmitNestedClass(StringBuilder sb, TypeDecl nested)
    {
        var stereotype = NestedStereotype(nested);
        if (stereotype is null)
        {
            // Integration events and nested aggregates are not part of the structure diagram.
            return;
        }

        sb.Append("    class ").Append(nested.Name).Append(" {\n");
        sb.Append("        <<").Append(stereotype).Append(">>\n");
        EmitClassRows(sb, ClassRows(nested));
        sb.Append("    }\n");
    }

    /// <summary>The stereotype (without guillemets) a nested type draws with, or null when it is not drawn.</summary>
    private static string? NestedStereotype(TypeDecl nested) => nested switch
    {
        ValueObjectDecl vo => vo.IsQuantity ? "quantity" : "value object",
        EnumDecl => "enumeration",
        EventDecl => "event",
        EntityDecl => "entity",
        _ => null
    };

    /// <summary>Emits the shared class rows into a Mermaid class body (tilde generics, <c>+</c> prefix for attributes/methods).</summary>
    private static void EmitClassRows(StringBuilder sb, IEnumerable<ClassRow> rows)
    {
        foreach (ClassRow row in rows)
        {
            switch (row.Kind)
            {
                case ClassRowKind.Field:
                    sb.Append("        +").Append(MermaidRowType(row)).Append(' ').Append(row.Name).Append('\n');
                    break;

                case ClassRowKind.Computed:
                    sb.Append("        +").Append(MermaidRowType(row)).Append(" /").Append(row.Name).Append('\n');
                    break;

                case ClassRowKind.Method:
                    sb.Append("        +").Append(row.Name).Append('(')
                      .Append(MermaidParams(row.Parameters ?? [])).Append(')');
                    if (row.ReturnType is not null)
                    {
                        sb.Append(' ').Append(MermaidType(row.ReturnType));
                    }

                    sb.Append('\n');
                    break;

                case ClassRowKind.Value:
                    sb.Append("        ").Append(row.Name).Append('\n');
                    break;
            }
        }
    }

    /// <summary>The Mermaid type text for a field row (its tilde-generic type, else empty).</summary>
    private static string MermaidRowType(ClassRow row) =>
        row.Type is { } t ? MermaidType(t) : string.Empty;

    // ---- shared class-body model (Mermaid + structured graph consume the same rows) ----

    /// <summary>
    /// The compartment a <see cref="ClassRow"/> belongs to: an attribute (<c>field</c>/<c>computed</c>, incl. the
    /// synthetic version/id rows), an operation (<c>method</c>, a factory or command), or an enum
    /// value (<c>value</c>). Mirrors the <see cref="DiagramMember"/> kinds so the graph builder maps
    /// 1:1; the renderer draws attributes/values above the divider and methods below it.
    /// </summary>
    internal enum ClassRowKind
    {
        Field,
        Computed,
        Method,
        Value
    }

    /// <summary>
    /// One target-neutral row of a class body, walked once by <see cref="ClassRows"/> and formatted two
    /// ways: the Mermaid emitter renders types with <see cref="MermaidType"/> (tilde generics), the
    /// structured-graph builder with <see cref="KoineType"/> (readable, source-like). A field carries a
    /// <see cref="Type"/> (a <see cref="TypeRef"/> normalised through the same type path as every other row,
    /// including the synthetic <c>version</c> row); a method carries <see cref="Parameters"/> and an optional
    /// <see cref="ReturnType"/>; a value is just a name.
    /// </summary>
    /// <param name="Name">The member/operation name, or the enum value name.</param>
    /// <param name="Kind">Which compartment the row belongs to.</param>
    /// <param name="Type">The field type, or <c>null</c> for a method/value row.</param>
    /// <param name="Parameters">A method's parameters (empty for non-methods).</param>
    /// <param name="ReturnType">A method's return type, or <c>null</c> for a void method/non-method.</param>
    internal sealed record ClassRow(
        string Name,
        ClassRowKind Kind,
        TypeRef? Type = null,
        IReadOnlyList<Param>? Parameters = null,
        TypeRef? ReturnType = null);

    /// <summary>
    /// The ordered rows of a class body — the SINGLE source of truth the Mermaid emitter and the
    /// structured-graph builder both walk, so they never drift. The order mirrors
    /// <see cref="EmitRootClass"/>/<see cref="EmitNestedClass"/>: for a root, version (when versioned),
    /// id, concrete fields, factories, then commands; for a value object/event, its concrete fields; for
    /// an enum, its member values; for an entity, id then concrete fields. Derived members are surfaced as
    /// <c>Computed</c> rows (same <see cref="MemberAnalysis.IsDerived"/> rule), not skipped. Returns an empty sequence for a type the
    /// structure diagram does not draw (integration events, nested aggregates).
    /// </summary>
    internal static IEnumerable<ClassRow> ClassRows(TypeDecl type, AggregateDecl? owningAggregate = null)
    {
        switch (type)
        {
            case EntityDecl entity when owningAggregate is not null && entity.Name == owningAggregate.RootName:
                if (owningAggregate.IsVersioned)
                {
                    yield return new ClassRow("version", ClassRowKind.Field, Type: new TypeRef("Int"));
                }

                yield return new ClassRow("id", ClassRowKind.Field, Type: new TypeRef(entity.IdentityName));
                foreach (ClassRow row in FieldRows(entity.Members))
                {
                    yield return row;
                }

                foreach (FactoryDecl factory in entity.Factories)
                {
                    yield return new ClassRow(
                        factory.Name, ClassRowKind.Method,
                        Parameters: factory.Parameters,
                        ReturnType: new TypeRef(entity.Name));
                }

                foreach (CommandDecl cmd in entity.Commands)
                {
                    yield return new ClassRow(
                        cmd.Name, ClassRowKind.Method,
                        Parameters: cmd.Parameters,
                        ReturnType: cmd.ReturnType);
                }

                break;

            case ValueObjectDecl vo:
                foreach (ClassRow row in FieldRows(vo.Members))
                {
                    yield return row;
                }

                break;

            case EnumDecl en:
                foreach (EnumMember member in en.Members)
                {
                    yield return new ClassRow(member.Name, ClassRowKind.Value);
                }

                break;

            case EventDecl ev:
                foreach (ClassRow row in FieldRows(ev.Members))
                {
                    yield return row;
                }

                break;

            case EntityDecl ent:
                yield return new ClassRow("id", ClassRowKind.Field, Type: new TypeRef(ent.IdentityName));
                foreach (ClassRow row in FieldRows(ent.Members))
                {
                    yield return row;
                }

                break;
        }
    }

    /// <summary>The field rows of a member list, in declaration order: a derived/computed member
    /// (its initializer references a sibling) becomes a <see cref="ClassRowKind.Computed"/> row,
    /// every other member a <see cref="ClassRowKind.Field"/> row.</summary>
    private static IEnumerable<ClassRow> FieldRows(IReadOnlyList<Member> members)
    {
        var names = new HashSet<string>(members.Select(m => m.Name), StringComparer.Ordinal);
        foreach (Member m in members)
        {
            ClassRowKind kind = MemberAnalysis.IsDerived(m, names)
                ? ClassRowKind.Computed
                : ClassRowKind.Field;
            yield return new ClassRow(m.Name, kind, Type: m.Type);
        }
    }

    private static string MermaidParams(IReadOnlyList<Param> parameters) =>
        string.Join(", ", parameters.Select(p => $"{MermaidType(p.Type)} {p.Name}"));

    /// <summary>
    /// Renders a type for a Mermaid class body. Mermaid parses <c>&lt;</c>/<c>&gt;</c> in generics, so a
    /// generic type is rendered with tilde notation (<c>List~OrderLine~</c>), Mermaid's own generic
    /// syntax, and optionality is dropped (not expressible in a member type).
    /// </summary>
    private static string MermaidType(TypeRef t) => t switch
    {
        { Value: not null, Element: not null } => $"{t.Name}~{MermaidType(t.Element)}, {MermaidType(t.Value)}~",
        { Element: not null } => $"{t.Name}~{MermaidType(t.Element)}~",
        _ => t.Name
    };
}
