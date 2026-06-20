using System.Text;
using Koine.Compiler.Ast;

namespace Koine.Compiler.Emit.CSharp;

/// <summary>
/// The behavioral-declaration slice of <see cref="CSharpEmitter"/> (R10): reusable
/// specifications, stateless domain services and policies, plus the spec-resolution
/// helpers shared with value-object/entity emission. Split out as a partial to keep
/// the orchestrating emitter focused.
/// </summary>
public sealed partial class CSharpEmitter
{
    // ----------------------------------------------------------------------
    // R10 — specifications, services, policies
    // ----------------------------------------------------------------------

    /// <summary>The spec name -&gt; body map for a target type (for inlining references).</summary>
    private static IReadOnlyDictionary<string, Expr> SpecBodiesFor(string typeName, ModelIndex index)
    {
        IReadOnlyDictionary<string, SpecDecl> specs = index.SpecsFor(typeName);
        if (specs.Count == 0)
        {
            return EmptySpecBodies;
        }

        return specs.ToDictionary(kv => kv.Key, kv => kv.Value.Condition, StringComparer.Ordinal);
    }

    private static readonly IReadOnlyDictionary<string, Expr> EmptySpecBodies = new Dictionary<string, Expr>();

    /// <summary>
    /// True when any spec on <paramref name="typeName"/> uses a LINQ-backed op, so a file
    /// that inlines such a spec into an invariant/requires imports <c>System.Linq</c>.
    /// Every spec is checked individually, so composition is covered transitively.
    /// </summary>
    private static bool SpecBodiesUseLinq(string typeName, ModelIndex index) =>
        index.SpecsFor(typeName).Values.Any(s => ExprUsesLinq(s.Condition));

    /// <summary>The members in scope for a spec on <paramref name="typeName"/> (entities add a synthetic <c>id</c>), resolved in <paramref name="context"/> when shared across contexts.</summary>
    private static IReadOnlyList<Member> SpecTargetMembers(string typeName, ModelIndex index, string? context = null)
    {
        if (!(context is not null && index.TryGetDeclIn(context, typeName, out TypeDecl decl)) && !index.TryGetDecl(typeName, out decl))
        {
            return Array.Empty<Member>();
        }

        return decl switch
        {
            ValueObjectDecl v => v.Members,
            EntityDecl e => e.Members.Append(new Member("id", new TypeRef(e.IdentityName), null)).ToList(),
            _ => Array.Empty<Member>()
        };
    }

    /// <summary>
    /// Emits a context's reusable specifications as boolean <b>extension methods</b> in a
    /// static <c>&lt;Context&gt;Specifications</c> class. Each predicate extends its target type
    /// (so it reads as <c>order.IsLarge()</c>); spec-to-spec references inline (R10.1).
    /// </summary>
    private EmittedFile EmitSpecifications(
        EmitContext emit,
        string ns,
        IReadOnlyList<SpecDecl> specs,
        ModelIndex index,
        CSharpTypeMapper typeMapper,
        IReadOnlyDictionary<string, string> enumMemberToType)
    {
        var sb = new StringBuilder();
        WriteXmlDoc(sb, "Reusable domain specifications (predicates) for this context.", "");
        sb.Append("public static class ").Append(ns).Append("Specifications\n{\n");

        var first = true;
        var usesLinq = false;
        foreach (SpecDecl spec in specs)
        {
            if (!first)
            {
                sb.Append('\n');
            }

            first = false;
            WriteXmlDoc(sb, spec.Doc, Indent);
            sb.Append(Indent).Append("public static bool ").Append(CSharpNaming.ToPascalCase(spec.Name))
              .Append("(this ").Append(spec.TargetType).Append(" x)\n");
            if (RefOnly)
            {
                WriteRefStubExpressionBody(sb);
                continue;
            }

            IReadOnlyList<Member> members = SpecTargetMembers(spec.TargetType, index, ContextOf(ns));
            var translator = new CSharpExpressionTranslator(
                index, members, enumMemberToType, SpecBodiesFor(spec.TargetType, index), memberReceiver: "x", context: ContextOf(ns), options: _options);
            var body = translator.TranslateTopLevel(spec.Condition, CSharpExpressionTranslator.NameMode.Property);
            sb.Append(Indent).Append(Indent).Append("=> ").Append(body).Append(";\n");
            usesLinq |= ExprUsesLinq(spec.Condition);
        }

        sb.Append("}\n");
        return new EmittedFile(PathFor(emit, ns, KindFolder.Specifications, $"{ns}Specifications.cs"), Assemble(emit, ns, sb.ToString(), usesLinq));
    }

    /// <summary>
    /// Emits a domain service as a stateless class. Pure operations become
    /// expression-bodied methods; a bodyless operation is an <c>abstract</c> seam
    /// (which makes the whole class <c>abstract</c>).
    /// </summary>
    private EmittedFile EmitService(
        EmitContext emit,
        ServiceDecl svc,
        string ns,
        ModelIndex index,
        CSharpTypeMapper typeMapper,
        IReadOnlyDictionary<string, string> enumMemberToType)
    {
        var isAbstract = svc.Operations.Any(o => o.Body is null);
        var sb = new StringBuilder();

        WriteXmlDoc(sb, svc.Doc ?? "A stateless domain service.", "");
        sb.Append("public ").Append(isAbstract ? "abstract" : "sealed").Append(" class ").Append(svc.Name).Append("\n{\n");

        var translator = new CSharpExpressionTranslator(index, Array.Empty<Member>(), enumMemberToType, context: ContextOf(ns), options: _options);
        var first = true;
        foreach (OperationDecl op in svc.Operations)
        {
            if (!first)
            {
                sb.Append('\n');
            }

            first = false;
            WriteXmlDoc(sb, op.Doc, Indent);

            var ret = typeMapper.Map(op.ReturnType);
            var paramList = string.Join(", ", op.Parameters.Select(p =>
                $"{typeMapper.Map(p.Type)} {CSharpNaming.ToCamelCase(p.Name)}"));
            var method = CSharpNaming.ToPascalCase(op.Name);

            if (op.Body is null)
            {
                sb.Append(Indent).Append("public abstract ").Append(ret).Append(' ')
                  .Append(method).Append('(').Append(paramList).Append(");\n");
            }
            else if (RefOnly)
            {
                sb.Append(Indent).Append("public ").Append(ret).Append(' ')
                  .Append(method).Append('(').Append(paramList).Append(")\n");
                WriteRefStubExpressionBody(sb);
            }
            else
            {
                foreach (Param p in op.Parameters)
                {
                    translator.PushLocal(p.Name, p.Type);
                }

                var expectedEnum = index.Classify(op.ReturnType.Name) == TypeKind.Enum ? op.ReturnType.Name : null;
                var body = translator.TranslateTopLevel(op.Body, CSharpExpressionTranslator.NameMode.Property, expectedEnum);
                foreach (Param p in op.Parameters)
                {
                    translator.PopLocal(p.Name);
                }

                sb.Append(Indent).Append("public ").Append(ret).Append(' ')
                  .Append(method).Append('(').Append(paramList).Append(")\n");
                sb.Append(Indent).Append(Indent).Append("=> ").Append(body).Append(";\n");
            }
        }

        sb.Append("}\n");
        var usesLinq = svc.Operations.Any(o => o.Body is not null && ExprUsesLinq(o.Body));
        return new EmittedFile(PathFor(emit, ns, KindFolder.Services, $"{svc.Name}.cs"), Assemble(emit, ns, sb.ToString(), usesLinq));
    }

    /// <summary>
    /// Emits a policy as a handler seam: an <c>I&lt;Name&gt;Policy</c> interface plus an
    /// <c>abstract partial</c> class whose <c>Handle</c> the consumer implements. The
    /// intended cross-aggregate reaction is recorded in a doc comment, never generated
    /// (honoring the no-imperative-logic stance).
    /// </summary>
    private EmittedFile EmitPolicy(
        EmitContext emit,
        PolicyDecl policy,
        string ns,
        ModelIndex index,
        IReadOnlyDictionary<string, string> enumMemberToType)
    {
        var policyType = CSharpNaming.ToPascalCase(policy.Name) + "Policy";
        var iface = "I" + policyType;

        // Render the reaction sketch with event fields rooted at the handler param `e`.
        IReadOnlyList<Member> eventMembers = index.TryGetDecl(policy.EventName, out TypeDecl ed) && ed is EventDecl ev
            ? ev.Members
            : Array.Empty<Member>();
        var translator = new CSharpExpressionTranslator(index, eventMembers, enumMemberToType, memberReceiver: "e", context: ContextOf(ns), options: _options);
        PolicyReaction r = policy.Reaction;
        var argText = string.Join(", ", r.Args.Select(a =>
            $"{a.Parameter}: {translator.TranslateTopLevel(a.Value, CSharpExpressionTranslator.NameMode.Property)}"));
        var sketch = $"{r.TargetType}.{r.CommandName}({argText})";

        var sb = new StringBuilder();
        WriteXmlDoc(sb, policy.Doc ?? $"Reacts to {policy.EventName} via {policy.Name}.", "");
        sb.Append("public interface ").Append(iface).Append("\n{\n");
        sb.Append(Indent).Append("Task Handle(").Append(policy.EventName).Append(" e, CancellationToken ct = default);\n");
        sb.Append("}\n\n");

        sb.Append("/// <summary>\n");
        sb.Append("/// Policy seam: when ").Append(EscapeXml(policy.EventName)).Append(" occurs, the intended reaction is\n");
        sb.Append("/// ").Append(EscapeXml(sketch)).Append(". Koine does not generate the cross-aggregate call\n");
        sb.Append("/// (no imperative logic in the model); implement Handle in a partial to wire it.\n");
        sb.Append("/// </summary>\n");
        sb.Append("public abstract partial class ").Append(policyType).Append(" : ").Append(iface).Append("\n{\n");
        sb.Append(Indent).Append("/// <remarks>Intended reaction: ").Append(EscapeXml(sketch)).Append(".</remarks>\n");
        sb.Append(Indent).Append("public abstract Task Handle(").Append(policy.EventName).Append(" e, CancellationToken ct = default);\n");
        sb.Append("}\n");

        return new EmittedFile(PathFor(emit, ns, KindFolder.Policies, $"{policyType}.cs"), Assemble(emit, ns, sb.ToString(), usesLinq: false));
    }
}
