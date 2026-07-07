using System.Text;
using Koine.Compiler.Ast;
using Koine.Compiler.Emit;

namespace Koine.Compiler;

/// <summary>
/// The application / CQRS slice of <see cref="PythonEmitter"/> (R12), the Python analogue of
/// <see cref="CSharp.CSharpEmitter"/>'s <c>CSharpEmitter.Cqrs.cs</c>: read models with their pure
/// projection mappers, and query objects handled through the generic <c>QueryHandler</c>
/// <c>Protocol</c> already shipped in <see cref="PyRuntime"/>. Self-contained, stdlib-only,
/// <c>mypy --strict</c>-clean output.
/// </summary>
public sealed partial class PythonEmitter
{
    // ----------------------------------------------------------------------
    // Read models — a frozen-dataclass DTO + a pure projection function
    // ----------------------------------------------------------------------

    /// <summary>
    /// Emits a read model (R12.3): a flat <c>@dataclass(frozen=True)</c> DTO of the projected fields
    /// plus a module-level <c>def to_&lt;name&gt;(src: Src) -&gt; M:</c> projection — the Python analogue
    /// of the C# value-equal <c>record</c> + <c>static To&lt;Name&gt;(this Src src)</c> extension. A
    /// direct field copies the source member (<c>src.field</c>); a derived field translates its
    /// projection rooted at <c>src</c> (the <see cref="PythonExpressionTranslator"/>'s configurable
    /// receiver, the analogue of the C# <c>memberReceiver: "src"</c>).
    /// </summary>
    private EmittedFile EmitReadModel(PyEmitContext emit, ReadModelDecl rm, string ns, PythonTypeMapper typeMapper)
    {
        // The read model lives in the base context namespace, so resolve its source there (R13.2).
        var context = ContextOf(ns);
        IReadOnlyList<Member> sourceMembers = ReadModelSourceMembers(context, rm.SourceType, emit.Index);
        var translator = new PythonExpressionTranslator(
            emit.Index, sourceMembers, emit.EnumMemberToType, typeMapper, context, memberReceiver: "src",
            regexMatchTimeoutMs: _options.RegexMatchTimeoutMs);

        var name = PythonNaming.ToPascalCase(rm.Name);
        var sourceName = PythonNaming.ToPascalCase(rm.SourceType);

        // Each field carries its Python type annotation, snake_case attribute name, and the
        // projection expression (rooted at `src`) used in the mapper.
        var fields = new List<(string PyType, string Attr, string Rhs)>();
        foreach (ReadModelField f in rm.Fields)
        {
            var attr = PythonNaming.EscapeIdentifier(PythonNaming.ToSnakeCase(f.Name));
            string pyType, rhs;
            if (f.Projection is null)
            {
                // Direct field: type and value come from the like-named source member.
                pyType = emit.Index.TryGetMemberType(context, rm.SourceType, f.Name, out TypeRef t)
                    ? typeMapper.Map(t)
                    : "object";
                rhs = "src." + attr;
            }
            else
            {
                pyType = typeMapper.Map(f.Type!);
                var expectedEnum = emit.Index.Classify(f.Type!.Name) == TypeKind.Enum ? f.Type!.Name : null;
                rhs = translator.Translate(f.Projection, PythonExpressionTranslator.NameMode.Property, expectedEnum);
            }

            fields.Add((pyType, attr, rhs));
        }

        var sb = new StringBuilder();
        sb.Append("@dataclass(frozen=True)\n");
        sb.Append("class ").Append(name).Append(":\n");
        WriteDoc(sb, rm.Doc, Indent);
        if (fields.Count == 0 && string.IsNullOrEmpty(rm.Doc))
        {
            sb.Append(Indent).Append("pass\n");
        }

        foreach (var (pyType, attr, _) in fields)
        {
            sb.Append(Indent).Append(attr).Append(": ").Append(pyType).Append('\n');
        }

        // The pure projection: `def to_<name>(src: Src) -> M:` constructing the DTO by keyword,
        // each argument copying or translating the matching field. Mirrors the C# `To<Name>` mapper.
        var funcName = PythonNaming.EscapeIdentifier("to_" + PythonNaming.ToSnakeCase(rm.Name));
        sb.Append('\n').Append('\n');
        sb.Append("def ").Append(funcName).Append("(src: ").Append(sourceName).Append(") -> ").Append(name).Append(":\n");
        sb.Append(Indent).Append("\"\"\"Projects ").Append(sourceName).Append(" to ").Append(name).Append(".\"\"\"\n");
        sb.Append(Indent).Append("return ").Append(name).Append('(');
        if (fields.Count > 0)
        {
            sb.Append('\n');
            foreach (var (_, attr, rhs) in fields)
            {
                sb.Append(Indent).Append(Indent).Append(attr).Append('=').Append(rhs).Append(",\n");
            }
            sb.Append(Indent);
        }
        sb.Append(")\n");

        return new EmittedFile(
            PathFor(ns, KindFolder.ReadModels, rm.Name),
            Assemble(emit, ns, sb.ToString(), name),
            Kind: KindForFolder(KindFolder.ReadModels));
    }

    // ----------------------------------------------------------------------
    // Queries — a frozen-dataclass DTO + a QueryHandler Protocol seam
    // ----------------------------------------------------------------------

    /// <summary>
    /// Emits a query object (R12.4): a frozen-dataclass DTO carrying the criteria plus a
    /// <c>&lt;Q&gt;Handler(QueryHandler[&lt;Q&gt;, &lt;Result&gt;], Protocol)</c> seam reusing the
    /// generic <c>QueryHandler</c> <c>Protocol</c> already shipped in <see cref="PyRuntime"/> — the
    /// Python analogue of the C# DTO handled via <c>IQueryHandler&lt;TQuery,TResult&gt;</c>. The result
    /// type maps through the shared <see cref="PythonTypeMapper"/>, so a <c>List&lt;M&gt;</c> result
    /// becomes <c>tuple[M, ...]</c> (the same immutable-sequence convention the repositories use), a
    /// single <c>M</c> stays <c>M</c>, and an optional single result is <c>M | None</c>.
    /// </summary>
    private EmittedFile EmitQuery(PyEmitContext emit, QueryDecl q, string ns, PythonTypeMapper typeMapper)
    {
        var name = PythonNaming.ToPascalCase(q.Name);
        var handlerName = name + "Handler";
        var resultType = typeMapper.Map(q.ResultType);

        var sb = new StringBuilder();
        sb.Append("@dataclass(frozen=True)\n");
        sb.Append("class ").Append(name).Append(":\n");
        WriteDoc(sb, q.Doc ?? $"Query returning {resultType}; handled by {handlerName}.", Indent);
        if (q.Criteria.Count == 0)
        {
            sb.Append(Indent).Append("pass\n");
        }

        foreach (Param p in q.Criteria)
        {
            sb.Append(Indent).Append(PythonNaming.EscapeIdentifier(PythonNaming.ToSnakeCase(p.Name)))
              .Append(": ").Append(typeMapper.Map(p.Type)).Append('\n');
        }

        // The handler seam: a Protocol specializing the generic QueryHandler. Including `Protocol` in
        // the bases keeps the specialization a structural protocol the consumer implements.
        sb.Append('\n').Append('\n');
        sb.Append("class ").Append(handlerName).Append('(')
          .Append("QueryHandler[").Append(name).Append(", ").Append(resultType).Append("], Protocol):\n");
        sb.Append(Indent).Append("\"\"\"Handles ").Append(name).Append(", returning ").Append(resultType).Append(".\"\"\"\n");

        return new EmittedFile(
            PathFor(ns, KindFolder.Queries, q.Name),
            Assemble(emit, ns, sb.ToString(), name),
            Kind: KindForFolder(KindFolder.Queries));
    }

    /// <summary>
    /// The members a read model projects from. An entity adds the synthetic <c>id</c> (unless it
    /// already declares one), mirroring the C# <c>ReadModelSourceMembers</c>.
    /// </summary>
    private static IReadOnlyList<Member> ReadModelSourceMembers(string context, string sourceType, ModelIndex index)
    {
        if (!index.TryGetDeclIn(context, sourceType, out TypeDecl decl) && !index.TryGetDecl(sourceType, out decl))
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
