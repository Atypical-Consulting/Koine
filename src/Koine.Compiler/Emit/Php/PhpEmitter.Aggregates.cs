using System.Text;
using Koine.Compiler.Ast;

namespace Koine.Compiler.Emit.Php;

/// <summary>
/// The aggregate slice of <see cref="PhpEmitter"/>: the aggregate root's persistence-ignorant
/// repository contract and a context's domain services, both emitted as PHP <c>interface</c>s
/// with synchronous method signatures (PHP has no built-in async). Mirrors the C#
/// <c>I&lt;Root&gt;Repository</c>/<c>I&lt;Service&gt;</c> interfaces and the Python Protocol
/// equivalents, but expressed as plain PHP interfaces.
/// <para>
/// A repository's persistence surface: <c>get</c>/<c>save</c> plus the configured mutating
/// operations (default getById/add/update/remove), then each declarative <c>find</c>. A versioned
/// aggregate's mutating operations include a concurrency comment noting that a stale write raises
/// <c>ConcurrencyConflictException</c>. Services are also emitted as interfaces.
/// </para>
/// </summary>
public sealed partial class PhpEmitter
{
    // -----------------------------------------------------------------------
    // Repositories — the aggregate root's persistence seam (interface, sync).
    // -----------------------------------------------------------------------

    /// <summary>The mutating operations a repository exposes when none are listed explicitly.</summary>
    private static readonly IReadOnlyList<string> DefaultRepositoryOps =
        new[] { "getById", "add", "update", "remove" };

    /// <summary>
    /// Emits the <c>&lt;Root&gt;Repository</c> interface for an aggregate: the fundamental
    /// <c>get</c> lookup (keyed on the root's branded ID, returning <c>?Root</c>), the
    /// configured mutating operations (default add/update/remove, all as <c>save</c>-shaped
    /// methods), and any declarative finders. Every member is a plain PHP interface method
    /// (synchronous — PHP has no async keyword). Returns <c>null</c> when the root entity
    /// cannot be resolved.
    /// </summary>
    private EmittedFile? EmitRepository(
        PhpEmitContext emit,
        AggregateDecl agg,
        EntityDecl? root,
        string contextName,
        PhpTypeMapper typeMapper)
    {
        if (root is null)
        {
            return null;
        }

        var rootName = PhpNaming.ClassName(root.Name);
        var idType = PhpNaming.ClassName(root.IdentityName);
        IReadOnlyList<string> ops = agg.Repository?.Operations ?? DefaultRepositoryOps;
        IReadOnlyList<FinderDecl> finders = agg.Repository?.Finders ?? Array.Empty<FinderDecl>();
        var interfaceName = rootName + "Repository";

        var sb = new StringBuilder();
        sb.Append("/** Persistence-ignorant repository contract for the ").Append(rootName).Append(" aggregate root. */\n");
        sb.Append("interface ").Append(interfaceName).Append('\n');
        sb.Append("{\n");

        var firstMember = true;
        void Gap()
        {
            if (!firstMember) sb.Append('\n');
            firstMember = false;
        }

        if (ops.Contains("getById"))
        {
            Gap();
            sb.Append(Indent).Append("public function get(").Append(idType).Append(" $id): ?")
              .Append(rootName).Append(";\n");
        }

        // The mutating operations (add/update/remove) all persist the aggregate.
        foreach (var op in new[] { "add", "update", "remove" })
        {
            if (ops.Contains(op))
            {
                Gap();
                var method = op == "add" ? "save" : PhpNaming.EscapeIdentifier(op);
                if (agg.IsVersioned && op != "add")
                {
                    sb.Append(Indent).Append("/** Enforces the aggregate's expected version; ")
                      .Append("throws ConcurrencyConflictException on a stale write. */\n");
                }

                sb.Append(Indent).Append("public function ").Append(method)
                  .Append("(").Append(rootName).Append(" $aggregate): void;\n");
            }
        }

        foreach (FinderDecl finder in finders)
        {
            Gap();
            var isList = finder.ResultType.Name == ModelIndex.ListTypeName;
            var ret = isList ? "array" : "?" + rootName;
            var method = PhpNaming.EscapeIdentifier(PhpNaming.MethodName(finder.Name));
            var paramParts = finder.Parameters.Select(p =>
                typeMapper.Map(p.Type) + " $" + PhpNaming.EscapeIdentifier(PhpNaming.PropertyName(p.Name)));
            var paramList = string.Join(", ", paramParts);

            sb.Append(Indent).Append("public function ").Append(method)
              .Append("(").Append(paramList).Append("): ").Append(ret).Append(";\n");
        }

        sb.Append("}\n");

        return new EmittedFile(
            PathFor(contextName, KindFolder.Repositories, interfaceName),
            Assemble(contextName, KindFolder.Repositories, sb.ToString(), interfaceName));
    }

    // -----------------------------------------------------------------------
    // Services — domain operations + application use cases (interface).
    // -----------------------------------------------------------------------

    /// <summary>
    /// Emits a service's interface(s). A service may carry pure domain <c>operations</c> and/or
    /// application <c>use cases</c>; each non-empty group emits one interface file:
    /// <list type="bullet">
    ///   <item>The pure-operations service emits <c>interface &lt;Name&gt;</c> with one method per
    ///   operation — an abstract signature (the PHP analogue of C#'s abstract method). If an
    ///   operation carries a body, the interface still declares the abstract signature (PHP
    ///   interfaces cannot carry implementations; use-site implementations provide them).</item>
    ///   <item>The application-service boundary emits <c>interface &lt;Name&gt;</c> with one method
    ///   per use case.</item>
    /// </list>
    /// </summary>
    private void EmitServiceFiles(
        PhpEmitContext emit,
        List<EmittedFile> files,
        ServiceDecl svc,
        string contextName,
        PhpTypeMapper typeMapper)
    {
        if (svc.Operations.Count > 0)
        {
            files.Add(EmitDomainService(emit, svc, contextName, typeMapper));
        }

        if (svc.UseCases.Count > 0)
        {
            files.Add(EmitApplicationService(emit, svc, contextName, typeMapper));
        }
    }

    private EmittedFile EmitDomainService(
        PhpEmitContext emit,
        ServiceDecl svc,
        string contextName,
        PhpTypeMapper typeMapper)
    {
        var name = PhpNaming.ClassName(svc.Name);
        var sb = new StringBuilder();
        WriteDoc(sb, svc.Doc ?? "A stateless domain service.", "");
        sb.Append("interface ").Append(name).Append('\n');
        sb.Append("{\n");

        var first = true;
        foreach (OperationDecl op in svc.Operations)
        {
            if (!first) sb.Append('\n');
            first = false;

            WriteDoc(sb, op.Doc, Indent);
            var method = PhpNaming.EscapeIdentifier(PhpNaming.MethodName(op.Name));
            var ret = typeMapper.Map(op.ReturnType);
            var paramParts = op.Parameters.Select(p =>
                typeMapper.Map(p.Type) + " $" + PhpNaming.EscapeIdentifier(PhpNaming.PropertyName(p.Name)));
            var paramList = string.Join(", ", paramParts);

            sb.Append(Indent).Append("public function ").Append(method)
              .Append("(").Append(paramList).Append("): ").Append(ret).Append(";\n");
        }

        sb.Append("}\n");

        return new EmittedFile(
            PathFor(contextName, KindFolder.Root, svc.Name),
            Assemble(contextName, KindFolder.Root, sb.ToString(), name));
    }

    private EmittedFile EmitApplicationService(
        PhpEmitContext emit,
        ServiceDecl svc,
        string contextName,
        PhpTypeMapper typeMapper)
    {
        var name = PhpNaming.ClassName(svc.Name);
        var sb = new StringBuilder();
        WriteDoc(sb, svc.Doc ?? $"Application-service boundary for the {svc.Name} use cases.", "");
        sb.Append("interface ").Append(name).Append('\n');
        sb.Append("{\n");

        var first = true;
        foreach (UseCaseDecl uc in svc.UseCases)
        {
            if (!first) sb.Append('\n');
            first = false;

            WriteDoc(sb, uc.Doc, Indent);
            var method = PhpNaming.EscapeIdentifier(PhpNaming.MethodName(uc.Name));
            var ret = uc.ReturnType is null ? "void" : typeMapper.Map(uc.ReturnType);
            var paramParts = uc.Parameters.Select(p =>
                typeMapper.Map(p.Type) + " $" + PhpNaming.EscapeIdentifier(PhpNaming.PropertyName(p.Name)));
            var paramList = string.Join(", ", paramParts);

            sb.Append(Indent).Append("public function ").Append(method)
              .Append("(").Append(paramList).Append("): ").Append(ret).Append(";\n");
        }

        sb.Append("}\n");

        return new EmittedFile(
            PathFor(contextName, KindFolder.Root, svc.Name),
            Assemble(contextName, KindFolder.Root, sb.ToString(), name));
    }
}
