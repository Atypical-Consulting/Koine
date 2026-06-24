using System.Text;
using Koine.Compiler.Ast;

namespace Koine.Compiler.Emit.Rust;

/// <summary>
/// The events/CQRS slice of <see cref="RustEmitter"/>. A Koine <c>event</c> (and cross-boundary
/// <c>integration event</c>) emits as a plain data struct with public fields plus a <c>new</c>
/// constructor — events carry no invariants, so public fields are the idiomatic shape. All of a
/// context's events are additionally collected into a single <c>DomainEvent</c> enum (one variant per
/// event) so a handler can hold a <c>Vec&lt;DomainEvent&gt;</c> and <c>match</c> them exhaustively.
/// <para>
/// Smart enums (Task 4) already emit as data-free Rust <c>enum</c>s whose associated-data accessors are
/// exhaustive <c>match</c>es with no <c>_</c> catch-all, so adding a variant is a downstream compile
/// error — the idiomatic <c>Match</c>/<c>Switch</c>/<c>Try*</c> shape. Event <c>emit</c> wiring,
/// factories, queries, and read models are a later phase (this is the tactical core).
/// </para>
/// </summary>
public sealed partial class RustEmitter
{
    private void EmitEvent(StringBuilder body, RustEmitContext emit, string context, string name, string? doc, IReadOnlyList<Member> members)
    {
        var typeMapper = new RustTypeMapper(emit.Index, context, _options);
        var typeName = RustNaming.ToPascalCase(name);

        WriteDoc(body, doc, string.Empty);
        body.Append("#[derive(Debug, Clone, PartialEq)]\n");
        body.Append("pub struct ").Append(typeName).Append(" {\n");
        foreach (Member m in members)
        {
            WriteDoc(body, m.Doc, Indent);
            body.Append(Indent).Append("pub ").Append(RustNaming.Field(m.Name)).Append(": ").Append(typeMapper.Map(m.Type)).Append(",\n");
        }
        body.Append("}\n\n");

        var ctorParams = string.Join(", ", members.Select(m => RustNaming.Field(m.Name) + ": " + typeMapper.Map(m.Type)));
        body.Append("impl ").Append(typeName).Append(" {\n");
        body.Append(Indent).Append("pub fn new(").Append(ctorParams).Append(") -> Self {\n");
        body.Append(Indent).Append(Indent).Append(typeName).Append(" {\n");
        foreach (Member m in members)
        {
            body.Append(Indent).Append(Indent).Append(Indent).Append(RustNaming.Field(m.Name)).Append(",\n");
        }
        body.Append(Indent).Append(Indent).Append("}\n");
        body.Append(Indent).Append("}\n");
        body.Append("}\n");
    }

    /// <summary>
    /// Emits the context-wide <c>DomainEvent</c> enum collecting every event/integration-event of the
    /// context as a variant, so a handler can hold and exhaustively <c>match</c> a
    /// <c>Vec&lt;DomainEvent&gt;</c>. Emits nothing when the context declares no events.
    /// </summary>
    private void EmitDomainEventEnum(StringBuilder body, ContextNode ctx)
    {
        var events = ctx.AllTypeDecls()
            .Where(t => t is EventDecl or IntegrationEventDecl)
            .Select(t => RustNaming.ToPascalCase(t.Name))
            .Distinct(StringComparer.Ordinal)
            .OrderBy(n => n, StringComparer.Ordinal)
            .ToList();
        if (events.Count == 0)
        {
            return;
        }

        body.Append('\n');
        body.Append("/// Every domain event this context can raise — a `Vec`-friendly, exhaustively matchable enum.\n");
        body.Append("#[derive(Debug, Clone, PartialEq)]\n");
        body.Append("pub enum DomainEvent {\n");
        foreach (var ev in events)
        {
            body.Append(Indent).Append(ev).Append('(').Append(ev).Append("),\n");
        }
        body.Append("}\n");
    }

    /// <summary>
    /// Emits a read model (R12.3) as a flat projection struct plus a <c>from_&lt;source&gt;</c> associated
    /// function that projects a borrowed source aggregate/entity into it. A direct field copies the
    /// like-named source member through its accessor (owned: a String via <c>to_string</c>, another value
    /// via <c>clone</c>, a Copy scalar/enum verbatim); a derived field projects its expression over the source.
    /// </summary>
    private void EmitReadModel(StringBuilder body, RustEmitContext emit, ReadModelDecl rm, string context)
    {
        var typeMapper = new RustTypeMapper(emit.Index, context, _options);
        var name = RustNaming.ToPascalCase(rm.Name);
        // The source may be owned by another bounded context (the validator resolves it locally then
        // globally), so qualify it as `crate::<module>::<Source>` when foreign.
        var sourceName = typeMapper.QualifyTypeName(rm.SourceType);
        IReadOnlyList<Member> sourceMembers = ReadModelSourceMembers(context, rm.SourceType, emit.Index);
        var byName = new Dictionary<string, Member>(StringComparer.Ordinal);
        foreach (Member m in sourceMembers)
        {
            byName.TryAdd(m.Name, m);
        }

        // A derived field projects an expression over the borrowed `src`, every member through its accessor.
        var translator = new RustExpressionTranslator(
            emit.Index, sourceMembers, emit.EnumMemberToType, typeMapper, context,
            memberReceiver: "src", membersAsAccessors: true);

        var fields = new List<(string Field, string RustType, string Rhs)>();
        foreach (ReadModelField f in rm.Fields)
        {
            string rhs;
            TypeRef fieldType;
            if (f.Projection is null)
            {
                // Direct: copy the like-named source member through its accessor, owned for storage.
                fieldType = byName.TryGetValue(f.Name, out Member? sm) ? sm.Type : new TypeRef("String");
                rhs = OwnAccess("src." + RustNaming.Field(f.Name) + "()", fieldType, typeMapper);
            }
            else
            {
                fieldType = f.Type!;
                var expectedEnum = emit.Index.Classify(fieldType.Name) == TypeKind.Enum ? fieldType.Name : null;
                var rendered = RustExpressionTranslator.StripOuterParens(translator.Translate(f.Projection, expectedEnum));
                rhs = OwnDerived(rendered, fieldType, typeMapper);
            }

            fields.Add((RustNaming.Field(f.Name), typeMapper.Map(fieldType), rhs));
        }

        WriteDoc(body, rm.Doc, string.Empty);
        body.Append("#[derive(Debug, Clone, PartialEq)]\n");
        body.Append("pub struct ").Append(name).Append(" {\n");
        foreach (var f in fields)
        {
            body.Append(Indent).Append("pub ").Append(f.Field).Append(": ").Append(f.RustType).Append(",\n");
        }

        body.Append("}\n\n");

        body.Append("impl ").Append(name).Append(" {\n");
        body.Append(Indent).Append("/// Projects a `").Append(sourceName).Append("` into a `").Append(name).Append("`.\n");
        body.Append(Indent).Append("pub fn from_").Append(RustNaming.ToSnakeCase(rm.SourceType))
            .Append("(src: &").Append(sourceName).Append(") -> Self {\n");
        body.Append(Indent).Append(Indent).Append("Self {\n");
        foreach (var f in fields)
        {
            body.Append(Indent).Append(Indent).Append(Indent).Append(f.Field).Append(": ").Append(f.Rhs).Append(",\n");
        }

        body.Append(Indent).Append(Indent).Append("}\n");
        body.Append(Indent).Append("}\n");
        body.Append("}\n");
    }

    /// <summary>Owns a direct accessor result: a String via <c>to_string</c>, another non-Copy value via <c>clone</c>, a Copy value verbatim.</summary>
    private static string OwnAccess(string access, TypeRef type, RustTypeMapper typeMapper) =>
        typeMapper.IsCopy(type) ? access
        : type is { Name: "String", IsOptional: false } ? access + ".to_string()"
        : access + ".clone()";

    /// <summary>Owns a derived projection expression (wrapped so the suffix binds the whole expression).</summary>
    private static string OwnDerived(string rendered, TypeRef type, RustTypeMapper typeMapper)
    {
        if (typeMapper.IsCopy(type))
        {
            return rendered;
        }

        var suffix = type is { Name: "String", IsOptional: false } ? ".to_string()" : ".clone()";
        return "(" + rendered + ")" + suffix;
    }

    /// <summary>The members a read model projects from (an entity adds the synthetic <c>id</c> unless it declares its own).</summary>
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
            _ => Array.Empty<Member>(),
        };
    }

    /// <summary>
    /// Emits a query object (R12.4) as a DTO struct carrying its typed criteria plus a <c>new</c>
    /// constructor. The result type lives in the doc comment; dispatch is the application layer's concern.
    /// </summary>
    private void EmitQuery(StringBuilder body, RustEmitContext emit, QueryDecl q, string context)
    {
        var typeMapper = new RustTypeMapper(emit.Index, context, _options);
        var name = RustNaming.ToPascalCase(q.Name);
        var resultType = typeMapper.Map(q.ResultType);

        WriteDoc(body, q.Doc ?? $"Query criteria returning `{resultType}`.", string.Empty);
        body.Append("#[derive(Debug, Clone, PartialEq)]\n");
        body.Append("pub struct ").Append(name).Append(" {\n");
        foreach (Param p in q.Criteria)
        {
            body.Append(Indent).Append("pub ").Append(RustNaming.Field(p.Name)).Append(": ").Append(typeMapper.Map(p.Type)).Append(",\n");
        }

        body.Append("}\n\n");

        var ctorParams = string.Join(", ", q.Criteria.Select(p => RustNaming.Field(p.Name) + ": " + typeMapper.Map(p.Type)));
        body.Append("impl ").Append(name).Append(" {\n");
        body.Append(Indent).Append("pub fn new(").Append(ctorParams).Append(") -> Self {\n");
        body.Append(Indent).Append(Indent).Append("Self {\n");
        foreach (Param p in q.Criteria)
        {
            body.Append(Indent).Append(Indent).Append(Indent).Append(RustNaming.Field(p.Name)).Append(",\n");
        }

        body.Append(Indent).Append(Indent).Append("}\n");
        body.Append(Indent).Append("}\n");
        body.Append("}\n");
    }
}
