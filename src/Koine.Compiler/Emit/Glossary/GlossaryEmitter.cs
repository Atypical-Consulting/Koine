using System.Text;
using Koine.Compiler.Ast;

namespace Koine.Compiler.Emit.Glossary;

/// <summary>
/// Emits a Markdown ubiquitous-language glossary from a validated model, grouped
/// by bounded context then aggregate. It consumes ONLY the target-agnostic
/// <see cref="KoineModel"/> (no <c>Emit/CSharp</c> types), proving that doc and
/// rule data live in the AST. Output is deterministic (declaration order, no
/// timestamps), so re-running is byte-identical.
/// </summary>
public sealed class GlossaryEmitter : IEmitter
{
    public string TargetName => "glossary";

    public const string FileName = "glossary.md";

    public IReadOnlyList<EmittedFile> Emit(KoineModel model)
    {
        var sb = new StringBuilder();
        sb.Append("# Ubiquitous Language Glossary\n");

        foreach (ContextNode ctx in model.Contexts)
        {
            sb.Append("\n## ").Append(ctx.Name);
            if (ctx.Version is { } version)
            {
                sb.Append(" — version ").Append(version);
            }

            sb.Append('\n');
            if (!string.IsNullOrEmpty(ctx.Doc))
            {
                sb.Append('\n').Append(Prose(ctx.Doc)).Append('\n');
            }

            foreach (TypeDecl type in ctx.Types)
            {
                WriteType(sb, type, level: 3);
            }

            WriteBehavioral(sb, ctx);
        }

        return new[] { new EmittedFile(FileName, sb.ToString()) };
    }

    /// <summary>Renders the context's R10 behavioral declarations: specs, services, policies.</summary>
    private static void WriteBehavioral(StringBuilder sb, ContextNode ctx)
    {
        var specs = ctx.Specs.Concat(
            ctx.Types.OfType<AggregateDecl>().SelectMany(a => a.Specs)).ToList();

        if (specs.Count > 0)
        {
            sb.Append("\n### Specifications\n");
            foreach (SpecDecl spec in specs)
            {
                sb.Append("\n- `").Append(spec.Name).Append("` on `").Append(spec.TargetType).Append('`')
                  .Append(string.IsNullOrEmpty(spec.Doc) ? "" : " — " + spec.Doc!.Replace('\n', ' ')).Append('\n');
            }
        }

        if (ctx.Services.Count > 0)
        {
            sb.Append("\n### Services\n");
            foreach (ServiceDecl svc in ctx.Services)
            {
                sb.Append("\n- **").Append(svc.Name).Append("**")
                  .Append(string.IsNullOrEmpty(svc.Doc) ? "" : " — " + svc.Doc!.Replace('\n', ' ')).Append('\n');
                foreach (OperationDecl op in svc.Operations)
                {
                    sb.Append("  - `").Append(op.Name).Append('(')
                      .Append(string.Join(", ", op.Parameters.Select(p => $"{p.Name}: {p.Type.Name}")))
                      .Append("): ").Append(op.ReturnType.Name).Append('`')
                      .Append(op.Body is null ? " *(seam)*" : "").Append('\n');
                }
            }
        }

        if (ctx.Policies.Count > 0)
        {
            sb.Append("\n### Policies\n");
            foreach (PolicyDecl p in ctx.Policies)
            {
                sb.Append("\n- **").Append(p.Name).Append("** — when `").Append(p.EventName)
                  .Append("` then `").Append(p.Reaction.TargetType).Append('.').Append(p.Reaction.CommandName)
                  .Append("`\n");
            }
        }
    }

    private static void WriteType(StringBuilder sb, TypeDecl type, int level)
    {
        var heading = new string('#', level);

        switch (type)
        {
            case AggregateDecl agg:
                sb.Append('\n').Append(heading).Append(' ').Append(agg.Name)
                  .Append(" — aggregate (root: ").Append(agg.RootName).Append(')').Append(Tag(agg)).Append('\n');
                if (!string.IsNullOrEmpty(agg.Doc))
                {
                    sb.Append('\n').Append(Prose(agg.Doc)).Append('\n');
                }

                foreach (TypeDecl nested in agg.Types)
                {
                    WriteType(sb, nested, level + 1);
                }

                break;

            case EnumDecl en:
                WriteHeading(sb, heading, en.Name, "enum", en.Doc, Tag(en));
                sb.Append("\nValues: ").Append(string.Join(", ", en.MemberNames)).Append('\n');
                break;

            case ValueObjectDecl vo:
                WriteHeading(sb, heading, vo.Name, vo.IsQuantity ? "quantity" : "value", vo.Doc, Tag(vo));
                WriteFields(sb, vo.Members);
                WriteRules(sb, vo.Invariants);
                break;

            case EventDecl ev:
                WriteHeading(sb, heading, ev.Name, "event", ev.Doc, Tag(ev));
                WriteFields(sb, ev.Members);
                break;

            case IntegrationEventDecl ie:
                WriteHeading(sb, heading, ie.Name, "integration event", ie.Doc, Tag(ie));
                WriteFields(sb, ie.Members);
                break;

            case EntityDecl e:
                WriteHeading(sb, heading, e.Name, "entity", e.Doc, Tag(e));
                sb.Append("\nIdentified by `").Append(e.IdentityName).Append("`.\n");
                WriteFields(sb, e.Members);
                WriteRules(sb, e.Invariants);
                break;
        }
    }

    /// <summary>The evolution suffix for a type/field heading: <c> _(since v2; deprecated: reason)_</c> (R15.1).</summary>
    private static string Tag(TypeDecl t) => MarkdownDoc.Tag(t);

    private static void WriteHeading(StringBuilder sb, string heading, string name, string kind, string? doc, string tag = "")
    {
        sb.Append('\n').Append(heading).Append(' ').Append(name).Append(" — ").Append(kind).Append(tag).Append('\n');
        if (!string.IsNullOrEmpty(doc))
        {
            sb.Append('\n').Append(Prose(doc)).Append('\n');
        }
    }

    private static void WriteFields(StringBuilder sb, IReadOnlyList<Member> members) =>
        MarkdownDoc.WriteFields(sb, members);

    private static void WriteRules(StringBuilder sb, IReadOnlyList<Invariant> invariants) =>
        MarkdownDoc.WriteRules(sb, invariants);

    /// <summary>Normalizes a doc/rule for prose (single line, escaped).</summary>
    private static string Prose(string text) => MarkdownDoc.Prose(text);
}
