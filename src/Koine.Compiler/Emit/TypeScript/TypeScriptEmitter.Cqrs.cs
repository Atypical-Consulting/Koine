using System.Text;
using Koine.Compiler.Ast;

namespace Koine.Compiler.Emit.TypeScript;

/// <summary>
/// The application/CQRS slice of <see cref="TypeScriptEmitter"/> (R12), the TypeScript counterpart
/// of <see cref="CSharp.CSharpEmitter"/>'s <c>EmitApplicationService</c>/<c>EmitReadModel</c>/
/// <c>EmitQuery</c>:
/// <list type="bullet">
/// <item><b>Application services</b> — an <c>I&lt;Name&gt;</c> interface with one async method per
/// use case (<c>Promise&lt;void&gt;</c> or <c>Promise&lt;Result&gt;</c>), the TS analogue of the C#
/// <c>Task</c>-returning boundary.</item>
/// <item><b>Read models</b> — a value-shape <c>interface</c> of the projected fields plus a
/// standalone <c>&lt;Name&gt;Projection(src)</c> mapper that projects the source type. Direct fields
/// copy the like-named source property; derived fields translate their projection (rooted at
/// <c>src</c>).</item>
/// <item><b>Queries</b> — an <c>interface</c> DTO carrying the query criteria.</item>
/// </list>
/// Idiomatic TS throughout: <c>export interface</c>, <c>Promise&lt;T&gt;</c>, camelCase members.
/// </summary>
public sealed partial class TypeScriptEmitter
{
    // ----------------------------------------------------------------------
    // Application services (use cases) — an interface of async methods.
    // ----------------------------------------------------------------------

    /// <summary>
    /// Emits a service's application boundary (R12.2): an <c>I&lt;Name&gt;</c> interface with one async
    /// method per use case. A use case with a declared output returns <c>Promise&lt;Result&gt;</c>;
    /// one without returns <c>Promise&lt;void&gt;</c> — the TS analogue of C#'s <c>Task</c>/<c>Task&lt;T&gt;</c>.
    /// Interface only, no implementation, matching the C# emitter.
    /// </summary>
    private EmittedFile EmitApplicationService(TsEmitContext emit, ServiceDecl svc, string ns, TypeScriptTypeMapper typeMapper)
    {
        var iface = "I" + TypeScriptNaming.ToPascalCase(svc.Name);
        var sb = new StringBuilder();
        WriteDoc(sb, svc.Doc ?? $"Application-service boundary for the {svc.Name} use cases.", "");
        sb.Append("export interface ").Append(iface).Append(" {\n");

        var first = true;
        foreach (UseCaseDecl uc in svc.UseCases)
        {
            if (!first)
            {
                sb.Append('\n');
            }

            first = false;
            WriteDoc(sb, uc.Doc, Indent);
            var ret = uc.ReturnType is null ? "Promise<void>" : $"Promise<{typeMapper.Map(uc.ReturnType)}>";
            var paramList = string.Join(", ", uc.Parameters.Select(p =>
                $"{TypeScriptNaming.ToCamelCase(p.Name)}: {typeMapper.Map(p.Type)}"));
            sb.Append(Indent).Append(TypeScriptNaming.ToCamelCase(uc.Name))
              .Append('(').Append(paramList).Append("): ").Append(ret).Append(";\n");
        }

        sb.Append("}\n");
        return new EmittedFile(
            PathFor(ns, KindFolder.Services, iface),
            Assemble(emit, ns, KindFolder.Services, sb.ToString(), iface, svc.Span));
    }

    // ----------------------------------------------------------------------
    // Read models — a flat DTO interface + a projection mapper function.
    // ----------------------------------------------------------------------

    /// <summary>
    /// Emits a read model (R12.3): an <c>interface</c> of the projected fields plus a standalone
    /// <c>&lt;Name&gt;Projection(src: Source): &lt;Name&gt;</c> mapper (the TS analogue of the C#
    /// <c>To&lt;Name&gt;</c> extension method — TS has no extension methods, so a plain function is
    /// idiomatic). Direct fields copy the like-named source property; derived fields translate their
    /// projection rooted at <c>src</c>.
    /// </summary>
    private EmittedFile EmitReadModel(
        TsEmitContext emit, ReadModelDecl rm, string ns, TypeScriptTypeMapper typeMapper)
    {
        var name = TypeScriptNaming.ToPascalCase(rm.Name);
        var sourceType = TypeScriptNaming.ToPascalCase(rm.SourceType);
        var context = ContextOf(ns);
        ModelIndex index = emit.Index;
        IReadOnlyList<Member> sourceMembers = ReadModelSourceMembers(context, rm.SourceType, index);

        // The translator renders source-member references as `src.<camelCase>` (the parameter name),
        // so the read model's projections read directly off the projected-from instance.
        var translator = new TypeScriptExpressionTranslator(
            index, sourceMembers, emit.EnumMemberToType, typeMapper, context, memberReceiver: "src");

        var fields = new List<(string TsType, string Prop, string Rhs)>();
        foreach (ReadModelField f in rm.Fields)
        {
            var prop = TypeScriptNaming.ToCamelCase(f.Name);
            string tsType, rhs;
            if (f.Projection is null)
            {
                // Direct field: type and value come from the like-named source member.
                tsType = index.TryGetMemberType(context, rm.SourceType, f.Name, out TypeRef t) ? typeMapper.Map(t) : "unknown";
                rhs = "src." + prop;
            }
            else
            {
                tsType = typeMapper.Map(f.Type!);
                var expectedEnum = index.Classify(f.Type!.Name) == TypeKind.Enum ? f.Type!.Name : null;
                rhs = translator.Translate(f.Projection, TypeScriptExpressionTranslator.NameMode.Property, expectedEnum);
            }
            fields.Add((tsType, prop, rhs));
        }

        var sb = new StringBuilder();
        WriteDoc(sb, rm.Doc, "");
        sb.Append("export interface ").Append(name).Append(" {\n");
        foreach (var (tsType, prop, _) in fields)
        {
            sb.Append(Indent).Append("readonly ").Append(prop).Append(": ").Append(tsType).Append(";\n");
        }
        sb.Append("}\n\n");

        WriteDoc(sb, $"Projects {sourceType} to {name}.", "");
        sb.Append("export function ").Append(name).Append("Projection(src: ").Append(sourceType)
          .Append("): ").Append(name).Append(" {\n");
        sb.Append(Indent).Append("return {\n");
        foreach (var (_, prop, rhs) in fields)
        {
            sb.Append(Indent).Append(Indent).Append(prop).Append(": ").Append(rhs).Append(",\n");
        }
        sb.Append(Indent).Append("};\n");
        sb.Append("}\n");

        return new EmittedFile(
            PathFor(ns, KindFolder.ReadModels, name),
            Assemble(emit, ns, KindFolder.ReadModels, sb.ToString(), name, rm.Span));
    }

    /// <summary>
    /// The members a read model projects from (entities add the synthetic <c>id</c>, unless the
    /// entity already declares its own <c>id</c> member). Mirrors the C# emitter's helper of the same
    /// name so both backends scope their projections over the same source surface.
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

    // ----------------------------------------------------------------------
    // Queries — an interface DTO of the query criteria.
    // ----------------------------------------------------------------------

    /// <summary>
    /// Emits a query object (R12.4): an <c>interface</c> carrying the query criteria. The result type
    /// is recorded in the doc (the TS analogue of the C# query's <c>IQueryHandler</c> doc); a list
    /// result widens to a <c>readonly T[]</c>.
    /// </summary>
    private EmittedFile EmitQuery(TsEmitContext emit, QueryDecl q, string ns, TypeScriptTypeMapper typeMapper)
    {
        var name = TypeScriptNaming.ToPascalCase(q.Name);
        var resultType = typeMapper.Map(q.ResultType);

        var sb = new StringBuilder();
        WriteDoc(sb, q.Doc ?? $"Query returning {resultType}.", "");
        sb.Append("export interface ").Append(name).Append(" {\n");
        foreach (Param p in q.Criteria)
        {
            sb.Append(Indent).Append("readonly ").Append(TypeScriptNaming.ToCamelCase(p.Name)).Append(": ")
              .Append(typeMapper.Map(p.Type)).Append(";\n");
        }
        sb.Append("}\n");

        return new EmittedFile(
            PathFor(ns, KindFolder.Queries, name),
            Assemble(emit, ns, KindFolder.Queries, sb.ToString(), name, q.Span));
    }
}
