using System.Text;
using Koine.Compiler.Ast;

namespace Koine.Compiler.Emit.Php;

/// <summary>
/// The application / CQRS slice of <see cref="PhpEmitter"/> (R12), the PHP analogue of
/// <c>CSharpEmitter.Cqrs.cs</c> and <c>PythonEmitter.Cqrs.cs</c>: read models with their pure
/// projection mappers, and query objects with a <c>QueryHandler</c> interface seam reusing the
/// generic contract already shipped in <see cref="PhpRuntime"/>. Dependency-free PHP 8.1,
/// <c>readonly</c> promoted-property constructors, <c>declare(strict_types=1)</c>.
/// </summary>
public sealed partial class PhpEmitter
{
    // ----------------------------------------------------------------------
    // Read models — a final readonly DTO class + a pure projection function
    // ----------------------------------------------------------------------

    /// <summary>
    /// Emits a read model (R12.3): a <c>final readonly class</c> of the projected fields with
    /// promoted-property constructor plus a standalone <c>function to&lt;Name&gt;(&lt;Src&gt; $src):
    /// &lt;Name&gt;</c> projection — the PHP analogue of the C# value-equal <c>record</c> +
    /// <c>static To&lt;Name&gt;(this Src src)</c> extension. A direct field copies the source member
    /// (<c>$src-&gt;field</c>); a derived field translates the projection via
    /// <see cref="PhpExpressionTranslator"/> rooted at <c>$src</c> (the configurable
    /// <c>memberReceiver</c>).
    /// </summary>
    private EmittedFile EmitReadModel(PhpEmitContext emit, ReadModelDecl rm, string contextName, PhpTypeMapper typeMapper)
    {
        IReadOnlyList<Member> sourceMembers = ReadModelSourceMembers(contextName, rm.SourceType, emit.Index);
        var translator = new PhpExpressionTranslator(
            emit.Index, sourceMembers, emit.EnumMemberToType, context: contextName, memberReceiver: "src");

        var name = PhpNaming.ClassName(rm.Name);
        var sourceName = PhpNaming.ClassName(rm.SourceType);

        // Each field carries its PHP type-hint, camelCase property name, the projection
        // expression (rooted at $src) used in the mapper, and its declared Koine type (for the
        // phpstan PHPDoc refinement of a collection/Range field — null when a direct field's source
        // member type can't be resolved, i.e. the `mixed` fallback).
        var fields = new List<(string PhpType, string Prop, string Rhs, TypeRef? Type)>();
        foreach (ReadModelField f in rm.Fields)
        {
            var prop = PhpNaming.PropertyName(f.Name);
            string phpType, rhs;
            TypeRef? fieldType;
            if (f.Projection is null)
            {
                // Direct field: type and value come from the like-named source member.
                if (emit.Index.TryGetMemberType(contextName, rm.SourceType, f.Name, out TypeRef t))
                {
                    phpType = typeMapper.Map(t);
                    fieldType = t;
                }
                else
                {
                    phpType = "mixed";
                    fieldType = null;
                }

                rhs = "$src->" + prop;
            }
            else
            {
                phpType = typeMapper.Map(f.Type!);
                fieldType = f.Type;
                var expectedEnum = emit.Index.Classify(f.Type!.Name) == TypeKind.Enum ? f.Type!.Name : null;
                rhs = translator.Translate(f.Projection, PhpExpressionTranslator.NameMode.Property, expectedEnum);
            }

            fields.Add((phpType, prop, rhs, fieldType));
        }

        var sb = new StringBuilder();
        WriteDoc(sb, rm.Doc, "");

        // final readonly class with promoted properties in the constructor.
        sb.Append("final readonly class ").Append(name).Append('\n');
        sb.Append("{\n");

        // PHPDoc refines a promoted property whose native hint is a bare `array` (a copied/projected
        // collection field) or a generic `Range<T>`, so phpstan --level max sees `list<T>` /
        // `array<K,V>` / `Range<T>`. On a promoted parameter the `@param` types property and parameter.
        var docParams = fields
            .Where(f => f.Type is not null)
            .Select(f => (f.Prop, f.Type!))
            .ToList();
        WriteMethodDoc(sb, Indent, typeMapper, docParams, null, null);

        sb.Append(Indent).Append("public function __construct(\n");
        if (fields.Count == 0)
        {
            sb.Append(Indent).Append(") {}\n");
        }
        else
        {
            for (int i = 0; i < fields.Count; i++)
            {
                var (phpType, prop, _, _) = fields[i];
                bool last = i == fields.Count - 1;
                sb.Append(Indent).Append(Indent)
                  .Append("public ").Append(phpType).Append(" $").Append(prop);
                if (!last)
                {
                    sb.Append(',');
                }
                sb.Append('\n');
            }
            sb.Append(Indent).Append(") {}\n");
        }

        sb.Append("}\n");

        // The pure projection function: `function to<Name>(<Src> $src): <Name>`
        var funcName = "to" + name;
        sb.Append('\n');
        sb.Append("/** Projects ").Append(sourceName).Append(" to ").Append(name).Append(". */\n");
        sb.Append("function ").Append(funcName).Append('(').Append(sourceName).Append(" $src): ").Append(name).Append('\n');
        sb.Append("{\n");
        sb.Append(Indent).Append("return new ").Append(name).Append("(\n");
        if (fields.Count == 0)
        {
            sb.Append(Indent).Append(");\n");
        }
        else
        {
            foreach (var (_, _, rhs, _) in fields)
            {
                sb.Append(Indent).Append(Indent).Append(rhs).Append(",\n");
            }
            sb.Append(Indent).Append(");\n");
        }

        sb.Append("}\n");

        return new EmittedFile(
            PathFor(contextName, KindFolder.ReadModels, rm.Name),
            Assemble(contextName, KindFolder.ReadModels, sb.ToString(), name));
    }

    // ----------------------------------------------------------------------
    // Queries — a final readonly DTO class + a QueryHandler interface seam
    // ----------------------------------------------------------------------

    /// <summary>
    /// Emits a query object (R12.4): a <c>final readonly class</c> DTO carrying the criteria plus a
    /// <c>&lt;Q&gt;Handler</c> interface extending the generic <c>QueryHandler</c> contract already
    /// shipped in <see cref="PhpRuntime"/> — the PHP analogue of the C# DTO handled via
    /// <c>IQueryHandler&lt;TQuery,TResult&gt;</c>. The result type maps through
    /// <see cref="PhpTypeMapper"/>; a list result emits <c>array</c> (PHP's single collection type).
    /// </summary>
    private EmittedFile EmitQuery(PhpEmitContext emit, QueryDecl q, string contextName, PhpTypeMapper typeMapper)
    {
        var name = PhpNaming.ClassName(q.Name);
        var handlerName = name + "Handler";
        var resultType = typeMapper.Map(q.ResultType);

        var sb = new StringBuilder();
        WriteDoc(sb, q.Doc ?? $"Query returning {resultType}; handled by {handlerName}.", "");

        // Criteria DTO as a final readonly class.
        sb.Append("final readonly class ").Append(name).Append('\n');
        sb.Append("{\n");

        // PHPDoc refines a collection/Range criterion whose native hint is a bare `array`/`Range`,
        // so phpstan --level max sees `list<T>` / `array<K,V>` / `Range<T>`.
        var criteriaDocParams = q.Criteria
            .Select(p => (PhpNaming.PropertyName(p.Name), p.Type))
            .ToList();
        WriteMethodDoc(sb, Indent, typeMapper, criteriaDocParams, null, null);

        sb.Append(Indent).Append("public function __construct(\n");
        if (q.Criteria.Count == 0)
        {
            sb.Append(Indent).Append(") {}\n");
        }
        else
        {
            for (int i = 0; i < q.Criteria.Count; i++)
            {
                Param p = q.Criteria[i];
                var prop = PhpNaming.PropertyName(p.Name);
                var phpType = typeMapper.Map(p.Type);
                bool last = i == q.Criteria.Count - 1;
                sb.Append(Indent).Append(Indent)
                  .Append("public ").Append(phpType).Append(" $").Append(prop);
                if (!last)
                {
                    sb.Append(',');
                }
                sb.Append('\n');
            }
            sb.Append(Indent).Append(") {}\n");
        }

        sb.Append("}\n");

        // Handler seam: an interface extending the generic QueryHandler contract. The `@extends`
        // binds QueryHandler's TQuery/TResult to the concrete query and result, so phpstan
        // --level max sees the generic arguments instead of `missingType.generics`; a list result
        // threads `list<T>` via DocType (a bare `array` `@return` is `missingType.iterableValue`).
        var resultDoc = typeMapper.DocType(q.ResultType) ?? resultType;
        sb.Append('\n');
        sb.Append("/**\n");
        sb.Append(" * Handles ").Append(name).Append(", returning ").Append(resultDoc).Append(".\n");
        sb.Append(" *\n");
        sb.Append(" * @extends QueryHandler<").Append(name).Append(", ").Append(resultDoc).Append(">\n");
        sb.Append(" */\n");
        sb.Append("interface ").Append(handlerName).Append(" extends QueryHandler\n");
        sb.Append("{\n");
        sb.Append(Indent).Append("/** @return ").Append(resultDoc).Append(" */\n");
        sb.Append(Indent).Append("public function handle(mixed $query): mixed;\n");
        sb.Append("}\n");

        return new EmittedFile(
            PathFor(contextName, KindFolder.Queries, q.Name),
            Assemble(contextName, KindFolder.Queries, sb.ToString(), name));
    }

    /// <summary>
    /// The members a read model projects from. An entity adds the synthetic <c>id</c> (unless it
    /// already declares one), mirroring the C# and Python <c>ReadModelSourceMembers</c>.
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
