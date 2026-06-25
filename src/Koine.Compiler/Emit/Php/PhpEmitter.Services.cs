using System.Text;
using Koine.Compiler.Ast;

namespace Koine.Compiler.Emit.Php;

/// <summary>
/// The application/domain-service slice of <see cref="PhpEmitter"/> (R10.2 / R12.2):
/// <list type="bullet">
///   <item><b>Application-service boundary</b> (R12.2): a <c>service</c> with <c>usecase</c>s emits
///   a PHP <c>interface &lt;Name&gt;</c> whose methods are the use cases — <c>void</c> for a command
///   style use case (no <c>ReturnType</c>) or the mapped PHP type for a query-style one. Mirrors the
///   C# <c>I&lt;Name&gt;</c> interface pattern and the Python/TypeScript application-service
///   protocol/interface equivalents.</item>
///   <item><b>Domain service</b> (R10.2): a <c>service</c> with pure <c>operation</c>s emits a PHP
///   class — <c>final class</c> when all operations have bodies, <c>abstract class</c> when any is
///   bodyless (an abstract seam). Each concrete operation is a method that returns the translated
///   expression body; each bodyless operation is an <c>abstract</c> method declaration.</item>
///   <item><b>Specifications</b> (R10.1): a context's <c>spec</c> declarations (and any nested inside
///   aggregates) are gathered into a single <c>&lt;Context&gt;Specifications</c> final class of static
///   boolean predicate methods — <c>public static function is&lt;Name&gt;(TargetType $target): bool</c>
///   — mirroring the C# static-class extension predicates and the TypeScript exported-function module.
///   Each method translates the spec condition against the target type's members (rooted at the
///   <c>$target</c> parameter rather than <c>$this</c>). PHP has no extension methods, so static
///   methods on a dedicated class are idiomatic.</item>
/// </list>
/// </summary>
public sealed partial class PhpEmitter
{
    // -----------------------------------------------------------------------
    // Dispatcher — called from the Emit loop in PhpEmitter.cs
    // -----------------------------------------------------------------------

    /// <summary>
    /// Dispatches a single <see cref="ServiceDecl"/> to the operations and/or use-cases emitters,
    /// mirroring <c>PythonEmitter.EmitServiceFiles</c> and <c>TypeScriptEmitter</c>.
    /// </summary>
    private void EmitServiceFiles(
        PhpEmitContext emit,
        List<EmittedFile> files,
        ServiceDecl svc,
        string ctxName,
        PhpTypeMapper typeMapper)
    {
        if (svc.Operations.Count > 0)
        {
            files.Add(EmitDomainService(emit, svc, ctxName, typeMapper));
        }

        if (svc.UseCases.Count > 0)
        {
            files.Add(EmitApplicationService(emit, svc, ctxName, typeMapper));
        }
    }

    // -----------------------------------------------------------------------
    // R10.2 — Domain service → stateless class of pure operations
    // -----------------------------------------------------------------------

    /// <summary>
    /// Emits a domain service's pure operations as a PHP class.
    /// <para>
    /// A service where ALL operations have expression bodies → <c>final class</c>. A service
    /// where ANY operation is bodyless → <c>abstract class</c> (the bodyless operations become
    /// <c>abstract</c> method declarations — seams the consumer implements). This mirrors the
    /// TypeScript <c>abstract class</c> pattern and the C# domain-service class shape.
    /// </para>
    /// </summary>
    private EmittedFile EmitDomainService(
        PhpEmitContext emit, ServiceDecl svc, string ctxName, PhpTypeMapper typeMapper)
    {
        var name = PhpNaming.ClassName(svc.Name);
        var isAbstract = svc.Operations.Any(op => op.Body is null);

        var sb = new StringBuilder();
        WriteDoc(sb, svc.Doc ?? "A stateless domain service.", "");

        sb.Append(isAbstract ? "abstract " : "final ").Append("class ").Append(name).Append("\n{\n");

        var translator = new PhpExpressionTranslator(
            emit.Index,
            Array.Empty<Member>(),
            emit.EnumMemberToType,
            ctxName);

        var first = true;
        foreach (OperationDecl op in svc.Operations)
        {
            if (!first)
            {
                sb.Append('\n');
            }

            first = false;
            WriteDoc(sb, op.Doc, Indent);

            var method = PhpNaming.MethodName(op.Name);
            var ret = typeMapper.Map(op.ReturnType);
            var paramList = string.Join(", ", op.Parameters.Select(p =>
                $"{typeMapper.Map(p.Type)} ${PhpNaming.EscapeIdentifier(PhpNaming.MethodName(p.Name))}"));

            if (op.Body is null)
            {
                // Bodyless operation → abstract seam
                sb.Append(Indent).Append("abstract public function ").Append(method)
                  .Append('(').Append(paramList).Append("): ").Append(ret).Append(";\n");
            }
            else
            {
                // Concrete operation → translate expression body
                foreach (Param p in op.Parameters)
                {
                    translator.PushLocal(p.Name, p.Type);
                }

                var expectedEnum = emit.Index.Classify(op.ReturnType.Name) == TypeKind.Enum
                    ? op.ReturnType.Name
                    : null;
                var body = translator.Translate(op.Body, expectedEnum);

                foreach (Param p in op.Parameters)
                {
                    translator.PopLocal(p.Name);
                }

                sb.Append(Indent).Append("public function ").Append(method)
                  .Append('(').Append(paramList).Append("): ").Append(ret).Append("\n");
                sb.Append(Indent).Append("{\n");
                sb.Append(Indent).Append(Indent).Append("return ").Append(body).Append(";\n");
                sb.Append(Indent).Append("}\n");
            }
        }

        sb.Append("}\n");

        return new EmittedFile(
            PathFor(ctxName, KindFolder.Services, svc.Name),
            Assemble(ctxName, KindFolder.Services, sb.ToString(), name));
    }

    // -----------------------------------------------------------------------
    // R12.2 — Application service → use-case interface
    // -----------------------------------------------------------------------

    /// <summary>
    /// Emits a service's application boundary (R12.2) as a PHP <c>interface</c>: one method per
    /// use case. A use case with no <see cref="UseCaseDecl.ReturnType"/> (command-style) emits as
    /// <c>…: void</c>; a query-style use case emits as <c>…: &lt;MappedReturnType&gt;</c>.
    /// Mirrors the C# <c>I&lt;Name&gt;</c> interface and Python/TypeScript Protocol/interface.
    /// </summary>
    private EmittedFile EmitApplicationService(
        PhpEmitContext emit, ServiceDecl svc, string ctxName, PhpTypeMapper typeMapper)
    {
        var name = PhpNaming.ClassName(svc.Name);

        var sb = new StringBuilder();
        WriteDoc(sb, svc.Doc ?? $"Application-service boundary for the {svc.Name} use cases.", "");

        sb.Append("interface ").Append(name).Append("\n{\n");

        var first = true;
        foreach (UseCaseDecl uc in svc.UseCases)
        {
            if (!first)
            {
                sb.Append('\n');
            }

            first = false;
            WriteDoc(sb, uc.Doc, Indent);

            var method = PhpNaming.MethodName(uc.Name);
            var ret = uc.ReturnType is null ? "void" : typeMapper.Map(uc.ReturnType);
            var paramList = string.Join(", ", uc.Parameters.Select(p =>
                $"{typeMapper.Map(p.Type)} ${PhpNaming.EscapeIdentifier(PhpNaming.MethodName(p.Name))}"));

            sb.Append(Indent).Append("public function ").Append(method)
              .Append('(').Append(paramList).Append("): ").Append(ret).Append(";\n");
        }

        sb.Append("}\n");

        return new EmittedFile(
            PathFor(ctxName, KindFolder.Services, svc.Name),
            Assemble(ctxName, KindFolder.Services, sb.ToString(), name));
    }

    // -----------------------------------------------------------------------
    // R10.1 — Specifications → static predicate class
    // -----------------------------------------------------------------------

    /// <summary>
    /// Emits a context's reusable specifications (R10.1) as static boolean predicate methods on a
    /// <c>final class &lt;Context&gt;Specifications</c>. Each spec becomes:
    /// <c>public static function is&lt;Name&gt;(&lt;TargetType&gt; $target): bool</c> evaluating
    /// the spec condition with members rooted at <c>$target</c>. Mirrors the C# static-class
    /// extension predicates and the TypeScript exported-function module, adapting to PHP idiom
    /// (static class instead of extension methods or exported functions).
    /// </summary>
    private EmittedFile EmitSpecifications(
        PhpEmitContext emit,
        IReadOnlyList<SpecDecl> specs,
        string ctxName,
        PhpTypeMapper typeMapper)
    {
        var ctxPascal = PhpNaming.ToPascalCase(ctxName);
        var name = ctxPascal + "Specifications";

        var sb = new StringBuilder();
        WriteDoc(sb, $"Reusable boolean predicates for the {ctxName} bounded context.", "");
        sb.Append("final class ").Append(name).Append("\n{\n");

        var first = true;
        foreach (SpecDecl spec in specs)
        {
            if (!first)
            {
                sb.Append('\n');
            }

            first = false;
            WriteDoc(sb, spec.Doc, Indent);

            var fn = PhpNaming.MethodName("is" + PhpNaming.ToPascalCase(spec.Name));
            var targetClass = PhpNaming.ClassName(spec.TargetType);

            // Gather target-type members so the translator can resolve member references.
            IReadOnlyList<Member> members = SpecTargetMembers(ctxName, spec.TargetType, emit.Index);
            var translator = new PhpExpressionTranslator(
                emit.Index,
                members,
                emit.EnumMemberToType,
                ctxName,
                memberReceiver: "target");

            var body = translator.Translate(spec.Condition, PhpExpressionTranslator.NameMode.Property);

            sb.Append(Indent).Append("public static function ").Append(fn)
              .Append('(').Append(targetClass).Append(" $target): bool\n");
            sb.Append(Indent).Append("{\n");
            sb.Append(Indent).Append(Indent).Append("return ").Append(body).Append(";\n");
            sb.Append(Indent).Append("}\n");
        }

        sb.Append("}\n");

        return new EmittedFile(
            PathFor(ctxName, KindFolder.Specifications, name),
            Assemble(ctxName, KindFolder.Specifications, sb.ToString(), name));
    }

    /// <summary>
    /// Members in scope for a spec on <paramref name="targetType"/>: entities get a synthetic
    /// <c>id</c> member added (unless the entity already declares one). Mirrors the C# and TS
    /// emitters' <c>SpecTargetMembers</c>.
    /// </summary>
    private static IReadOnlyList<Member> SpecTargetMembers(string ctxName, string targetType, ModelIndex index)
    {
        if (!index.TryGetDeclIn(ctxName, targetType, out TypeDecl? decl) && !index.TryGetDecl(targetType, out decl))
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
}
