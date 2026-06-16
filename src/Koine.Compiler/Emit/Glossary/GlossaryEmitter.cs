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
    private static string Tag(TypeDecl t) => Tag(t.Since, t.Deprecated);

    private static string Tag(int? since, string? deprecated)
    {
        var parts = new List<string>();
        if (since is { } s)
        {
            parts.Add("since v" + s);
        }

        if (!string.IsNullOrEmpty(deprecated))
        {
            parts.Add("deprecated: " + deprecated);
        }

        return parts.Count == 0 ? string.Empty : " _(" + Prose(string.Join("; ", parts)) + ")_";
    }

    private static void WriteHeading(StringBuilder sb, string heading, string name, string kind, string? doc, string tag = "")
    {
        sb.Append('\n').Append(heading).Append(' ').Append(name).Append(" — ").Append(kind).Append(tag).Append('\n');
        if (!string.IsNullOrEmpty(doc))
        {
            sb.Append('\n').Append(Prose(doc)).Append('\n');
        }
    }

    private static void WriteFields(StringBuilder sb, IReadOnlyList<Member> members)
    {
        if (members.Count == 0)
        {
            return;
        }

        var names = new HashSet<string>(members.Select(m => m.Name), StringComparer.Ordinal);

        sb.Append("\n| Field | Type | Description |\n| --- | --- | --- |\n");
        foreach (Member m in members)
        {
            var description = Cell(m.Doc);
            if (MemberAnalysis.IsDerived(m, names))
            {
                description = description.Length == 0 ? "_derived_" : "_derived_ — " + description;
            }

            var tag = Tag(m.Since, m.Deprecated);
            if (tag.Length != 0)
            {
                description = description.Length == 0 ? tag.Trim() : description + tag;
            }

            sb.Append("| ").Append(m.Name)
              .Append(" | `").Append(KoineType(m.Type)).Append('`')
              .Append(" | ").Append(description).Append(" |\n");
        }
    }

    private static void WriteRules(StringBuilder sb, IReadOnlyList<Invariant> invariants)
    {
        if (invariants.Count == 0)
        {
            return;
        }

        sb.Append("\n**Business rules**\n");
        foreach (Invariant inv in invariants)
        {
            sb.Append("- ").Append(Prose(inv.Message ?? Describe(inv.Condition))).Append('\n');
        }
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
    private static string Describe(Expr e) => DescribeVisitor.Instance.Visit(e);

    /// <summary>
    /// Renders an expression compactly for the glossary. Exhaustive
    /// (<see cref="ExprVisitor{T}"/>): every node — including <c>let … in …</c> — renders rather
    /// than collapsing to an ellipsis placeholder.
    /// </summary>
    private sealed class DescribeVisitor : ExprVisitor<string>
    {
        public static readonly DescribeVisitor Instance = new();

        private DescribeVisitor() { }

        protected override string VisitIdentifier(IdentifierExpr n) => n.Name;

        protected override string VisitLiteral(LiteralExpr n) =>
            n.Kind == LiteralKind.String ? $"\"{n.Text}\"" : n.Text;

        protected override string VisitMemberAccess(MemberAccessExpr n) => $"{Visit(n.Target)}.{n.MemberName}";

        protected override string VisitCall(CallExpr n) =>
            $"{Visit(n.Target)}.{n.Method}({string.Join(", ", n.Args.Select(Visit))})";

        protected override string VisitLambda(LambdaExpr n) => $"{n.Parameter} => {Visit(n.Body)}";

        protected override string VisitConditional(ConditionalExpr n) =>
            $"if {Visit(n.Condition)} then {Visit(n.Then)} else {Visit(n.Else)}";

        protected override string VisitCoalesce(CoalesceExpr n) => $"{Visit(n.Left)} ?? {Visit(n.Right)}";

        protected override string VisitUnary(UnaryExpr n) => (n.Op == UnaryOp.Not ? "!" : "-") + Visit(n.Operand);

        protected override string VisitBinary(BinaryExpr n) => $"{Visit(n.Left)} {Operator(n.Op)} {Visit(n.Right)}";

        protected override string VisitMatch(MatchExpr n) => $"{Visit(n.Target)} matches /{n.Pattern}/";

        protected override string VisitGuard(GuardExpr n) => $"{Visit(n.Body)} when {Visit(n.Condition)}";

        protected override string VisitLet(LetExpr n) =>
            $"let {string.Join(", ", n.Bindings.Select(b => $"{b.Name} = {Visit(b.Value)}"))} in {Visit(n.Body)}";
    }

    private static string Operator(BinaryOp op) => op switch
    {
        BinaryOp.Or => "||",
        BinaryOp.And => "&&",
        BinaryOp.Eq => "==",
        BinaryOp.Neq => "!=",
        BinaryOp.Lt => "<",
        BinaryOp.Le => "<=",
        BinaryOp.Gt => ">",
        BinaryOp.Ge => ">=",
        BinaryOp.Add => "+",
        BinaryOp.Sub => "-",
        BinaryOp.Mul => "*",
        BinaryOp.Div => "/",
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
