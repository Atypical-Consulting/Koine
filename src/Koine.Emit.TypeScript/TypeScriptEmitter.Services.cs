using System.Text;
using Koine.Compiler.Ast;
using Koine.Compiler.Emit;

namespace Koine.Compiler;

/// <summary>
/// The R10 behavioral slice of <see cref="TypeScriptEmitter"/>, the TypeScript counterpart of
/// <see cref="CSharp.CSharpEmitter"/>'s <c>EmitSpecifications</c>/<c>EmitService</c>:
/// <list type="bullet">
/// <item><b>Specifications</b> — a module of boolean predicate functions, one per <c>spec</c>
/// (<c>export function isLarge(target: Order): boolean</c>), evaluating the spec condition against
/// the target type's members (rooted at the <c>target</c> parameter). The TS analogue of the C#
/// static-class extension predicates — TS has no extension methods, so plain exported functions are
/// idiomatic.</item>
/// <item><b>Domain services</b> — a stateless <c>class</c> whose pure <c>operation</c>s become
/// methods computing each operation body (mirroring the C# stateless service class). A bodyless
/// operation is an <c>abstract</c> seam (making the class <c>abstract</c>).</item>
/// </list>
/// Idiomatic TS throughout: <c>export function</c>/<c>export class</c>, camelCase members, expression
/// bodies translated by <see cref="TypeScriptExpressionTranslator"/>.
/// </summary>
public sealed partial class TypeScriptEmitter
{
    // ----------------------------------------------------------------------
    // Specifications — a module of boolean predicate functions.
    // ----------------------------------------------------------------------

    /// <summary>
    /// Emits a context's reusable specifications (R10.1) as boolean predicate functions in a
    /// <c>&lt;Context&gt;Specifications.ts</c> module. Each predicate reads
    /// <c>export function is&lt;Name&gt;(target: &lt;TargetType&gt;): boolean</c> and evaluates the
    /// spec's condition against the target's members (rooted at <c>target</c>). Mirrors the C#
    /// emitter's per-context <c>&lt;Context&gt;Specifications</c> static class.
    /// </summary>
    private EmittedFile EmitSpecifications(
        TsEmitContext emit, IReadOnlyList<SpecDecl> specs, string ns, TypeScriptTypeMapper typeMapper)
    {
        ModelIndex index = emit.Index;
        var context = ContextOf(ns);
        var name = TypeScriptNaming.ToPascalCase(context) + "Specifications";

        var sb = new StringBuilder();

        var first = true;
        foreach (SpecDecl spec in specs)
        {
            if (!first)
            {
                sb.Append('\n');
            }

            first = false;

            var targetType = TypeScriptNaming.ToPascalCase(spec.TargetType);
            var fn = "is" + SpecPredicateSubject(TypeScriptNaming.ToPascalCase(spec.Name));

            WriteDoc(sb, spec.Doc, "");
            sb.Append("export function ").Append(fn).Append("(target: ").Append(targetType)
              .Append("): boolean {\n");
            if (RefOnly)
            {
                sb.Append(Indent).Append(RefStubStatement).Append('\n');
                sb.Append("}\n");
                continue;
            }

            IReadOnlyList<Member> members = SpecTargetMembers(context, spec.TargetType, index);
            var translator = new TypeScriptExpressionTranslator(
                index, members, emit.EnumMemberToType, typeMapper, context, memberReceiver: "target",
                regexMatchTimeoutMs: _options.RegexMatchTimeoutMs);
            var body = translator.Translate(spec.Condition, TypeScriptExpressionTranslator.NameMode.Property);
            sb.Append(Indent).Append("return ").Append(body).Append(";\n");
            sb.Append("}\n");
        }

        return new EmittedFile(
            PathFor(ns, KindFolder.Specifications, name),
            Assemble(emit, ns, KindFolder.Specifications, sb.ToString(), name, specs[0].Span));
    }

    /// <summary>
    /// The PascalCase spec subject with a redundant leading <c>Is</c> word stripped, so the emitted
    /// <c>is</c>-predicate name doesn't double: <c>IsFreeOrder</c> → <c>FreeOrder</c> (→ <c>isFreeOrder</c>),
    /// not <c>isIsFreeOrder</c>. A name that merely starts with "Is" (e.g. <c>Island</c>) is left intact —
    /// the character after "Is" must be uppercase for it to count as a word prefix. Mirrors the identical
    /// de-doubling in the PHP emitter (#396).
    /// </summary>
    internal static string SpecPredicateSubject(string pascalName) =>
        pascalName.Length > 2 && pascalName[0] == 'I' && pascalName[1] == 's' && char.IsUpper(pascalName[2])
            ? pascalName[2..]
            : pascalName;

    /// <summary>
    /// The members in scope for a spec on <paramref name="targetType"/> — entities add a synthetic
    /// <c>id</c> member (unless the entity already declares its own). Mirrors the C# emitter's
    /// <c>SpecTargetMembers</c> so both backends scope spec conditions over the same surface.
    /// </summary>
    private static IReadOnlyList<Member> SpecTargetMembers(string context, string targetType, ModelIndex index)
    {
        if (!index.TryGetDeclIn(context, targetType, out TypeDecl decl) && !index.TryGetDecl(targetType, out decl))
        {
            return Array.Empty<Member>();
        }

        return decl switch
        {
            ValueObjectDecl v => v.Members,
            EntityDecl e => e.Members.Any(m => string.Equals(m.Name, "id", StringComparison.OrdinalIgnoreCase))
                ? e.Members
                : e.Members.Append(new Member("id", new TypeRef(e.IdentityName), null)).ToList(),
            _ => Array.Empty<Member>()
        };
    }

    // ----------------------------------------------------------------------
    // Domain services — a stateless class of pure operations.
    // ----------------------------------------------------------------------

    /// <summary>
    /// Emits a domain service (R10.2) as a stateless <c>class</c>: each pure <c>operation</c> becomes
    /// a method computing its body expression (parameters are locals in scope for the body). A
    /// bodyless operation is an <c>abstract</c> seam, which makes the whole class <c>abstract</c> —
    /// the TS analogue of the C# stateless domain-service class.
    /// </summary>
    private EmittedFile EmitService(TsEmitContext emit, ServiceDecl svc, string ns, TypeScriptTypeMapper typeMapper)
    {
        ModelIndex index = emit.Index;
        var context = ContextOf(ns);
        var name = TypeScriptNaming.ToPascalCase(svc.Name);
        var isAbstract = svc.Operations.Any(o => o.Body is null);

        var sb = new StringBuilder();
        WriteDoc(sb, svc.Doc ?? "A stateless domain service.", "");
        sb.Append("export ").Append(isAbstract ? "abstract " : "").Append("class ").Append(name).Append(" {\n");

        var translator = new TypeScriptExpressionTranslator(
            index, Array.Empty<Member>(), emit.EnumMemberToType, typeMapper, context,
            regexMatchTimeoutMs: _options.RegexMatchTimeoutMs);

        var first = true;
        foreach (OperationDecl op in svc.Operations)
        {
            if (!first)
            {
                sb.Append('\n');
            }

            first = false;
            WriteDoc(sb, op.Doc, Indent);

            var method = TypeScriptNaming.ToCamelCase(op.Name);
            var ret = typeMapper.Map(op.ReturnType);
            var paramList = string.Join(", ", op.Parameters.Select(p =>
                $"{TypeScriptNaming.ToCamelCase(p.Name)}: {typeMapper.Map(p.Type)}"));

            if (op.Body is null)
            {
                sb.Append(Indent).Append("abstract ").Append(method).Append('(').Append(paramList)
                  .Append("): ").Append(ret).Append(";\n");
            }
            else if (RefOnly)
            {
                sb.Append(Indent).Append(method).Append('(').Append(paramList).Append("): ").Append(ret).Append(" {\n");
                sb.Append(Indent).Append(Indent).Append(RefStubStatement).Append('\n');
                sb.Append(Indent).Append("}\n");
            }
            else
            {
                foreach (Param p in op.Parameters)
                {
                    translator.PushLocal(p.Name, p.Type);
                }

                var expectedEnum = index.Classify(op.ReturnType.Name) == TypeKind.Enum ? op.ReturnType.Name : null;
                var body = translator.Translate(op.Body, TypeScriptExpressionTranslator.NameMode.Property, expectedEnum);
                foreach (Param p in op.Parameters)
                {
                    translator.PopLocal(p.Name);
                }

                sb.Append(Indent).Append(method).Append('(').Append(paramList).Append("): ").Append(ret).Append(" {\n");
                sb.Append(Indent).Append(Indent).Append("return ").Append(body).Append(";\n");
                sb.Append(Indent).Append("}\n");
            }
        }

        sb.Append("}\n");
        return new EmittedFile(
            PathFor(ns, KindFolder.Services, name),
            Assemble(emit, ns, KindFolder.Services, sb.ToString(), name, svc.Span));
    }
}
