using System.Text;
using Koine.Compiler.Ast;

namespace Koine.Compiler.Emit.Python;

/// <summary>
/// The aggregate slice of <see cref="PythonEmitter"/>: the aggregate root's persistence-ignorant
/// repository contract and a context's application/domain services, both emitted as
/// <c>typing.Protocol</c>s with <b>async</b> members (<c>async def … : ...</c>). Mirrors the C#
/// <c>I&lt;Root&gt;Repository</c>/<c>I&lt;Service&gt;</c> interfaces and the TS repository contract,
/// but expressed as structural Python protocols (the idiomatic Python seam — a hand-written adapter
/// satisfies them without inheriting).
/// <para>
/// A repository's persistence surface is asynchronous: <c>get</c>/<c>save</c> plus the configured
/// mutating operations, then each declarative <c>find</c>. A service's use cases are likewise async
/// boundaries; a service's pure domain <c>op</c>s become concrete methods when they carry a body and
/// abstract Protocol members (a seam) when they do not — matching the C#/TS treatment.
/// </para>
/// </summary>
public sealed partial class PythonEmitter
{
    // ----------------------------------------------------------------------
    // Repositories — the aggregate root's persistence seam (Protocol, async).
    // ----------------------------------------------------------------------

    /// <summary>The mutating + query operations a repository exposes when none are listed.</summary>
    private static readonly IReadOnlyList<string> DefaultRepositoryOps =
        new[] { "getById", "add", "update", "remove" };

    /// <summary>
    /// Emits the <c>&lt;Root&gt;Repository</c> Protocol for an aggregate: the fundamental
    /// <c>get</c> lookup (keyed on the root's branded ID, widened to <c>&lt;Root&gt; | None</c> — the
    /// Python analogue of the C# nullable <c>Root?</c> / TS <c>| undefined</c>), the configured
    /// mutating operations (default add/update/remove, all surfaced as a single async <c>save</c>
    /// per op), and any declarative finders (a list finder returns
    /// <c>tuple[&lt;Root&gt;, ...]</c>, a single finder <c>&lt;Root&gt; | None</c>). Every member is
    /// <c>async def … : ...</c> — a Protocol body, no implementation, mirroring C#/TS. Returns
    /// <c>null</c> when the root cannot be resolved (already a validation error).
    /// </summary>
    private EmittedFile? EmitRepository(
        PyEmitContext emit, AggregateDecl agg, EntityDecl? root, string ns, PythonTypeMapper typeMapper)
    {
        if (root is null)
        {
            return null;
        }

        var rootName = PythonNaming.ToPascalCase(root.Name);
        var idType = PythonNaming.ToPascalCase(root.IdentityName);
        IReadOnlyList<string> ops = agg.Repository?.Operations ?? DefaultRepositoryOps;
        IReadOnlyList<FinderDecl> finders = agg.Repository?.Finders ?? Array.Empty<FinderDecl>();
        var protocol = $"{rootName}Repository";

        var sb = new StringBuilder();
        sb.Append("class ").Append(protocol).Append("(Protocol):\n");
        WriteDoc(sb, $"Persistence-ignorant repository contract for the {rootName} aggregate root.", Indent);
        sb.Append('\n');

        var first = true;
        void Gap()
        {
            if (!first)
            {
                sb.Append('\n');
            }

            first = false;
        }

        if (ops.Contains("getById"))
        {
            Gap();
            sb.Append(Indent).Append("async def get(self, id: ").Append(idType).Append(") -> ")
              .Append(rootName).Append(" | None: ...\n");
        }

        // The mutating operations (add/update/remove) all persist the aggregate; each surfaces as an
        // async `save`-shaped member named for the op, taking the aggregate and returning None.
        foreach (var op in new[] { "add", "update", "remove" })
        {
            if (ops.Contains(op))
            {
                Gap();
                var method = op == "add" ? "save" : PythonNaming.EscapeIdentifier(op);
                if (agg.IsVersioned && op != "add")
                {
                    sb.Append(Indent).Append("# Enforces the aggregate's expected version; ")
                        .Append("raises ConcurrencyConflictError on a stale write.\n");
                }

                sb.Append(Indent).Append("async def ").Append(method).Append("(self, aggregate: ")
                  .Append(rootName).Append(") -> None: ...\n");
            }
        }

        foreach (FinderDecl finder in finders)
        {
            Gap();
            var isList = finder.ResultType.Name == ModelIndex.ListTypeName;
            var ret = isList ? $"tuple[{rootName}, ...]" : $"{rootName} | None";
            var method = PythonNaming.EscapeIdentifier(PythonNaming.ToSnakeCase(finder.Name));
            var paramList = string.Join(", ", finder.Parameters.Select(p =>
                $"{PythonNaming.EscapeIdentifier(PythonNaming.ToSnakeCase(p.Name))}: {typeMapper.Map(p.Type)}"));
            if (paramList.Length > 0)
            {
                paramList = ", " + paramList;
            }

            sb.Append(Indent).Append("async def ").Append(method).Append("(self").Append(paramList)
              .Append(") -> ").Append(ret).Append(": ...\n");
        }

        return new EmittedFile(
            PathFor(ns, KindFolder.Repositories, protocol),
            Assemble(emit, ns, sb.ToString(), protocol));
    }

    // ----------------------------------------------------------------------
    // Services — pure domain operations + application use cases (Protocol).
    // ----------------------------------------------------------------------

    /// <summary>
    /// Emits a service's Protocol(s). A service may carry pure domain <c>operations</c> (R10.2) and/or
    /// application <c>use cases</c> (R12.2); each non-empty group emits one Protocol module:
    /// <list type="bullet">
    ///   <item>The pure-operations service emits <c>class &lt;Name&gt;(Protocol)</c> with one member
    ///   per operation — a concrete <c>def</c> with the translated body when the op has one, an
    ///   abstract <c>def … : ...</c> seam when it does not (mirrors C# expression-bodied vs abstract).
    ///   </item>
    ///   <item>The application-service boundary emits <c>class &lt;Name&gt;(Protocol)</c> with one
    ///   <b>async</b> member per use case (<c>async def … -&gt; None: ...</c> for a void use case,
    ///   else <c>-&gt; &lt;ReturnType&gt;</c>).</item>
    /// </list>
    /// </summary>
    private void EmitServiceFiles(
        PyEmitContext emit, List<EmittedFile> files, ServiceDecl svc, string context, PythonTypeMapper typeMapper)
    {
        if (svc.Operations.Count > 0)
        {
            files.Add(EmitDomainService(emit, svc, context, typeMapper));
        }

        if (svc.UseCases.Count > 0)
        {
            files.Add(EmitApplicationService(emit, svc, context, typeMapper));
        }
    }

    /// <summary>
    /// Emits a domain service's pure operations as a <c>Protocol</c>. An operation with a body is a
    /// concrete method (the translated result expression); a bodyless operation is an abstract seam
    /// (<c>def … : ...</c>). Operations are synchronous (pure computation, not a persistence
    /// boundary). The service lands at the context package root.
    /// </summary>
    private EmittedFile EmitDomainService(PyEmitContext emit, ServiceDecl svc, string context, PythonTypeMapper typeMapper)
    {
        var name = PythonNaming.ToPascalCase(svc.Name);
        var sb = new StringBuilder();
        sb.Append("class ").Append(name).Append("(Protocol):\n");
        WriteDoc(sb, svc.Doc ?? "A stateless domain service.", Indent);
        sb.Append('\n');

        var translator = new PythonExpressionTranslator(emit.Index, Array.Empty<Member>(), emit.EnumMemberToType, typeMapper, context);
        var first = true;
        foreach (OperationDecl op in svc.Operations)
        {
            if (!first)
            {
                sb.Append('\n');
            }

            first = false;

            var method = PythonNaming.EscapeIdentifier(PythonNaming.ToSnakeCase(op.Name));
            var ret = typeMapper.Map(op.ReturnType);
            var paramList = string.Join("", op.Parameters.Select(p =>
                $", {PythonNaming.EscapeIdentifier(PythonNaming.ToSnakeCase(p.Name))}: {typeMapper.Map(p.Type)}"));

            if (op.Body is null)
            {
                WriteDoc(sb, op.Doc, Indent);
                sb.Append(Indent).Append("def ").Append(method).Append("(self").Append(paramList)
                  .Append(") -> ").Append(ret).Append(": ...\n");
            }
            else
            {
                foreach (Param p in op.Parameters)
                {
                    translator.PushLocal(p.Name, p.Type);
                }

                var expectedEnum = emit.Index.Classify(op.ReturnType.Name) == TypeKind.Enum ? op.ReturnType.Name : null;
                var body = translator.Translate(op.Body, expectedEnum);
                foreach (Param p in op.Parameters)
                {
                    translator.PopLocal(p.Name);
                }

                sb.Append(Indent).Append("def ").Append(method).Append("(self").Append(paramList)
                  .Append(") -> ").Append(ret).Append(":\n");
                WriteDoc(sb, op.Doc, Indent + Indent);
                sb.Append(Indent).Append(Indent).Append("return ").Append(body).Append('\n');
            }
        }

        return new EmittedFile(
            PathFor(context, KindFolder.Root, svc.Name),
            Assemble(emit, context, sb.ToString(), name));
    }

    /// <summary>
    /// Emits a service's application boundary as a <c>Protocol</c> (R12.2): one <b>async</b> member
    /// per use case (<c>async def … -&gt; None: ...</c> when the use case has no result, else
    /// <c>-&gt; &lt;ReturnType&gt;</c>), inputs mapped through the type mapper. The Python analogue of
    /// the C# <c>I&lt;Name&gt;</c> interface. Lands at the context package root.
    /// </summary>
    private EmittedFile EmitApplicationService(PyEmitContext emit, ServiceDecl svc, string context, PythonTypeMapper typeMapper)
    {
        var name = PythonNaming.ToPascalCase(svc.Name);
        var sb = new StringBuilder();
        sb.Append("class ").Append(name).Append("(Protocol):\n");
        WriteDoc(sb, svc.Doc ?? $"Application-service boundary for the {svc.Name} use cases.", Indent);
        sb.Append('\n');

        var first = true;
        foreach (UseCaseDecl uc in svc.UseCases)
        {
            if (!first)
            {
                sb.Append('\n');
            }

            first = false;
            WriteDoc(sb, uc.Doc, Indent);

            var method = PythonNaming.EscapeIdentifier(PythonNaming.ToSnakeCase(uc.Name));
            var ret = uc.ReturnType is null ? "None" : typeMapper.Map(uc.ReturnType);
            var paramList = string.Join("", uc.Parameters.Select(p =>
                $", {PythonNaming.EscapeIdentifier(PythonNaming.ToSnakeCase(p.Name))}: {typeMapper.Map(p.Type)}"));

            sb.Append(Indent).Append("async def ").Append(method).Append("(self").Append(paramList)
              .Append(") -> ").Append(ret).Append(": ...\n");
        }

        return new EmittedFile(
            PathFor(context, KindFolder.Root, svc.Name),
            Assemble(emit, context, sb.ToString(), name));
    }
}
