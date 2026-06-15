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

        foreach (var ctx in model.Contexts)
        {
            sb.Append("\n## ").Append(ctx.Name).Append('\n');
            if (!string.IsNullOrEmpty(ctx.Doc))
                sb.Append('\n').Append(Prose(ctx.Doc)).Append('\n');

            foreach (var type in ctx.Types)
                WriteType(sb, type, level: 3);
        }

        return new[] { new EmittedFile(FileName, sb.ToString()) };
    }

    private static void WriteType(StringBuilder sb, TypeDecl type, int level)
    {
        var heading = new string('#', level);

        switch (type)
        {
            case AggregateDecl agg:
                sb.Append('\n').Append(heading).Append(' ').Append(agg.Name)
                  .Append(" — aggregate (root: ").Append(agg.RootName).Append(")\n");
                if (!string.IsNullOrEmpty(agg.Doc))
                    sb.Append('\n').Append(Prose(agg.Doc)).Append('\n');
                foreach (var nested in agg.Types)
                    WriteType(sb, nested, level + 1);
                break;

            case EnumDecl en:
                WriteHeading(sb, heading, en.Name, "enum", en.Doc);
                sb.Append("\nValues: ").Append(string.Join(", ", en.MemberNames)).Append('\n');
                break;

            case ValueObjectDecl vo:
                WriteHeading(sb, heading, vo.Name, vo.IsQuantity ? "quantity" : "value", vo.Doc);
                WriteFields(sb, vo.Members);
                WriteRules(sb, vo.Invariants);
                break;

            case EventDecl ev:
                WriteHeading(sb, heading, ev.Name, "event", ev.Doc);
                WriteFields(sb, ev.Members);
                break;

            case EntityDecl e:
                WriteHeading(sb, heading, e.Name, "entity", e.Doc);
                sb.Append("\nIdentified by `").Append(e.IdentityName).Append("`.\n");
                WriteFields(sb, e.Members);
                WriteRules(sb, e.Invariants);
                break;
        }
    }

    private static void WriteHeading(StringBuilder sb, string heading, string name, string kind, string? doc)
    {
        sb.Append('\n').Append(heading).Append(' ').Append(name).Append(" — ").Append(kind).Append('\n');
        if (!string.IsNullOrEmpty(doc))
            sb.Append('\n').Append(Prose(doc)).Append('\n');
    }

    private static void WriteFields(StringBuilder sb, IReadOnlyList<Member> members)
    {
        if (members.Count == 0)
            return;

        var names = new HashSet<string>(members.Select(m => m.Name), StringComparer.Ordinal);

        sb.Append("\n| Field | Type | Description |\n| --- | --- | --- |\n");
        foreach (var m in members)
        {
            var description = Cell(m.Doc);
            if (MemberAnalysis.IsDerived(m, names))
                description = description.Length == 0 ? "_derived_" : "_derived_ — " + description;

            sb.Append("| ").Append(m.Name)
              .Append(" | `").Append(KoineType(m.Type)).Append('`')
              .Append(" | ").Append(description).Append(" |\n");
        }
    }

    private static void WriteRules(StringBuilder sb, IReadOnlyList<Invariant> invariants)
    {
        if (invariants.Count == 0)
            return;

        sb.Append("\n**Business rules**\n");
        foreach (var inv in invariants)
            sb.Append("- ").Append(Prose(inv.Message ?? Describe(inv.Condition))).Append('\n');
    }

    /// <summary>Renders a Koine type reference in source syntax (target-agnostic).</summary>
    private static string KoineType(TypeRef t)
    {
        var s = t switch
        {
            { Value: not null, Element: not null } => $"{t.Name}<{KoineType(t.Element)}, {KoineType(t.Value)}>",
            { Element: not null } => $"{t.Name}<{KoineType(t.Element)}>",
            _ => t.Name
        };
        return t.IsOptional ? s + "?" : s;
    }

    /// <summary>A compact, target-agnostic rendering of an expression (for unnamed rules).</summary>
    private static string Describe(Expr e) => e switch
    {
        IdentifierExpr id => id.Name,
        LiteralExpr { Kind: LiteralKind.String } lit => $"\"{lit.Text}\"",
        LiteralExpr lit => lit.Text,
        MemberAccessExpr ma => $"{Describe(ma.Target)}.{ma.MemberName}",
        CallExpr c => $"{Describe(c.Target)}.{c.Method}({string.Join(", ", c.Args.Select(Describe))})",
        LambdaExpr l => $"{l.Parameter} => {Describe(l.Body)}",
        ConditionalExpr cd => $"if {Describe(cd.Condition)} then {Describe(cd.Then)} else {Describe(cd.Else)}",
        CoalesceExpr co => $"{Describe(co.Left)} ?? {Describe(co.Right)}",
        UnaryExpr u => (u.Op == UnaryOp.Not ? "!" : "-") + Describe(u.Operand),
        BinaryExpr b => $"{Describe(b.Left)} {Operator(b.Op)} {Describe(b.Right)}",
        MatchExpr m => $"{Describe(m.Target)} matches /{m.Pattern}/",
        GuardExpr g => $"{Describe(g.Body)} when {Describe(g.Condition)}",
        _ => "…"
    };

    private static string Operator(BinaryOp op) => op switch
    {
        BinaryOp.Or => "||", BinaryOp.And => "&&",
        BinaryOp.Eq => "==", BinaryOp.Neq => "!=",
        BinaryOp.Lt => "<", BinaryOp.Le => "<=", BinaryOp.Gt => ">", BinaryOp.Ge => ">=",
        BinaryOp.Add => "+", BinaryOp.Sub => "-", BinaryOp.Mul => "*", BinaryOp.Div => "/",
        _ => "?"
    };

    /// <summary>Collapses a (possibly multi-line) doc into a single Markdown table cell.</summary>
    private static string Cell(string? doc) =>
        string.IsNullOrEmpty(doc) ? string.Empty : EscapeMarkdown(doc).Replace("\n", " ").Replace("|", "\\|");

    /// <summary>Normalizes a doc/rule for prose (single line, escaped).</summary>
    private static string Prose(string text) =>
        EscapeMarkdown(text).Replace("\r", string.Empty).Replace("\n", " ").Trim();

    /// <summary>Escapes characters Markdown/CommonMark treats as raw HTML or entities.</summary>
    private static string EscapeMarkdown(string s) =>
        s.Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;");
}
