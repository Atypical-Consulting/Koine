using System.Text;
using Koine.Compiler.Ast;

namespace Koine.Compiler.Emit.Docs;

/// <summary>
/// Aggregate slice of <see cref="DocsEmitter"/>: a Mermaid <c>classDiagram</c> showing the root entity
/// (stereotyped <c>&lt;&lt;aggregate root&gt;&gt;</c>) with its concrete fields and command/factory methods,
/// each nested type as a composition, and the repository finders/operations as a reference list beneath.
/// Derived (computed) members are omitted for clarity; declaration order is preserved.
/// </summary>
public sealed partial class DocsEmitter
{
    /// <summary>Writes the aggregate structure diagram plus the repository reference block.</summary>
    private static void EmitAggregateClassDiagram(StringBuilder sb, AggregateDecl agg)
    {
        EntityDecl? root = agg.RootEntity();
        if (root is null)
        {
            return;
        }

        sb.Append("\n```mermaid\nclassDiagram\n");

        EmitRootClass(sb, agg, root);

        // Each nested type: a composition edge plus its own class declaration (in declaration order).
        foreach (TypeDecl nested in agg.Types)
        {
            if (nested.Name == agg.RootName)
            {
                continue;
            }

            sb.Append("    ").Append(root.Name).Append(" *-- ").Append(nested.Name).Append('\n');
            EmitNestedClass(sb, nested);
        }

        sb.Append("```\n");

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
        if (agg.IsVersioned)
        {
            sb.Append("        +int version\n");
        }

        sb.Append("        +").Append(root.IdentityName).Append(" id\n");

        var names = new HashSet<string>(root.Members.Select(m => m.Name), StringComparer.Ordinal);
        foreach (Member m in root.Members)
        {
            if (MemberAnalysis.IsDerived(m, names))
            {
                continue;
            }

            sb.Append("        +").Append(MermaidType(m.Type)).Append(' ').Append(m.Name).Append('\n');
        }

        foreach (FactoryDecl factory in root.Factories)
        {
            sb.Append("        +").Append(factory.Name).Append('(')
              .Append(MermaidParams(factory.Parameters)).Append(") ").Append(root.Name).Append('\n');
        }

        foreach (CommandDecl cmd in root.Commands)
        {
            sb.Append("        +").Append(cmd.Name).Append('(').Append(MermaidParams(cmd.Parameters)).Append(')');
            if (cmd.ReturnType is not null)
            {
                sb.Append(' ').Append(MermaidType(cmd.ReturnType));
            }

            sb.Append('\n');
        }

        sb.Append("    }\n");
    }

    /// <summary>Emits a nested type's class declaration with the appropriate stereotype.</summary>
    private static void EmitNestedClass(StringBuilder sb, TypeDecl nested)
    {
        switch (nested)
        {
            case ValueObjectDecl vo:
                sb.Append("    class ").Append(vo.Name).Append(" {\n");
                sb.Append("        <<").Append(vo.IsQuantity ? "quantity" : "value object").Append(">>\n");
                EmitFieldLines(sb, vo.Members);
                sb.Append("    }\n");
                break;

            case EnumDecl en:
                sb.Append("    class ").Append(en.Name).Append(" {\n");
                sb.Append("        <<enumeration>>\n");
                foreach (EnumMember member in en.Members)
                {
                    sb.Append("        ").Append(member.Name).Append('\n');
                }

                sb.Append("    }\n");
                break;

            case EventDecl ev:
                sb.Append("    class ").Append(ev.Name).Append(" {\n");
                sb.Append("        <<event>>\n");
                EmitFieldLines(sb, ev.Members);
                sb.Append("    }\n");
                break;

            case EntityDecl ent:
                sb.Append("    class ").Append(ent.Name).Append(" {\n");
                sb.Append("        <<entity>>\n");
                sb.Append("        +").Append(ent.IdentityName).Append(" id\n");
                EmitFieldLines(sb, ent.Members);
                sb.Append("    }\n");
                break;

            // Integration events and nested aggregates are not part of the structure diagram.
            default:
                break;
        }
    }

    /// <summary>Emits concrete (non-derived) field lines for a nested class body.</summary>
    private static void EmitFieldLines(StringBuilder sb, IReadOnlyList<Member> members)
    {
        var names = new HashSet<string>(members.Select(m => m.Name), StringComparer.Ordinal);
        foreach (Member m in members)
        {
            if (MemberAnalysis.IsDerived(m, names))
            {
                continue;
            }

            sb.Append("        +").Append(MermaidType(m.Type)).Append(' ').Append(m.Name).Append('\n');
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
