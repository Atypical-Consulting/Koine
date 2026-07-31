using System.Text;
using Koine.Compiler.Ast;
using Koine.Compiler.Emit;

namespace Koine.Compiler;

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
            emit.Index, sourceMembers, emit.EnumMemberToType, context: contextName, memberReceiver: "src",
            regexMatchTimeoutMs: _options.RegexMatchTimeoutMs);

        // Sibling names, so a directly-projected source member can be classified stored-vs-derived
        // the same way PhpExpressionTranslator does (ordinal, like its own `_memberNames`).
        var sourceMemberNames = new HashSet<string>(sourceMembers.Select(m => m.Name), StringComparer.Ordinal);

        var name = PhpNaming.ClassName(rm.Name);
        var sourceName = PhpNaming.ClassName(rm.SourceType);

        // Per-symbol import hint for Assemble/CollectUses (issue #1701): a direct field's `use`
        // import must resolve against the SOURCE type's own owning context, mirroring the
        // ResolveOwner-based Map/Classify fix below (#1638) — a sibling mechanism (the file's
        // cross-namespace `use` list) that fix didn't reach. Without a hint here, CollectUses falls
        // back to this read model's OWN context, so a same-named-but-unrelated local type can
        // silently shadow the source's real one.
        var symbolContext = new Dictionary<string, string>(StringComparer.Ordinal);

        // Each field carries its PHP type-hint, camelCase property name, the projection
        // expression (rooted at $src) used in the mapper, its declared Koine type (for the phpstan
        // PHPDoc refinement of a collection/Range field — null when a direct field's source member
        // type can't be resolved, i.e. the `mixed` fallback), and the context THAT type's own
        // declaration belongs to (a direct field mirrors its source's context; a projected field's
        // literal type belongs to this read model's own context) — so the PHPDoc refinement below
        // resolves a foreign-context collection element the same way its native type-hint already
        // does, instead of uniformly against this read model's own context (#1701).
        var fields = new List<(string PhpType, string Prop, string Rhs, TypeRef? Type, string DocContext)>();
        foreach (ReadModelField f in rm.Fields)
        {
            var prop = PhpNaming.PropertyName(f.Name);
            string phpType, rhs, docContext;
            TypeRef? fieldType;
            if (f.Projection is null)
            {
                // Direct field: type and value come from the like-named source member. The source type
                // (and thus this member's own declaration) may live in a DIFFERENT bounded context than
                // this read model (R12.3 cross-context projection) — classify/map a bare field type
                // against the SOURCE's own owning context, not this read model's, so a same-named but
                // differently-kinded sibling type declared locally here can't misclassify it (#1638).
                if (emit.Index.TryGetMemberType(contextName, rm.SourceType, f.Name, out TypeRef t))
                {
                    var ownerContext = emit.Index.ResolveOwner(rm.SourceType, contextName).Owner ?? contextName;
                    phpType = typeMapper.Map(t, ownerContext);
                    fieldType = t;
                    docContext = ownerContext;
                    CollectImportHints(t, ownerContext, symbolContext);
                }
                else
                {
                    phpType = "mixed";
                    fieldType = null;
                    docContext = contextName;
                }

                // A DERIVED (computed) source member is emitted as a getter METHOD on the source
                // entity/VO (see EmitEntity / EmitValueObject), so a direct projection of it must
                // CALL the getter — `$src->doubled()`, not a `$src->doubled` property read (an
                // undefined property under strict_types and a phpstan --level max error). This
                // mirrors PhpExpressionTranslator's stored-vs-derived rule for the projected-field
                // path; stored members stay a plain property read. (#615)
                Member? sourceMember = sourceMembers.FirstOrDefault(m => m.Name == f.Name);
                bool derived = sourceMember is not null
                    && MemberAnalysis.IsDerived(sourceMember, sourceMemberNames);
                rhs = derived ? "$src->" + prop + "()" : "$src->" + prop;
            }
            else
            {
                phpType = typeMapper.Map(f.Type!, contextName);
                fieldType = f.Type;
                docContext = contextName;
                var expectedEnum = emit.Index.Classify(f.Type!.Qualifier ?? translator.Context, f.Type!.Name) == TypeKind.Enum ? f.Type!.Name : null;
                rhs = translator.Translate(f.Projection, PhpExpressionTranslator.NameMode.Property, expectedEnum);
            }

            fields.Add((phpType, prop, rhs, fieldType, docContext));
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
            .Select(f => (f.Prop, f.Type!, (string?)f.DocContext))
            .ToList();
        WriteMethodDoc(sb, Indent, typeMapper, docParams, null, null, contextName);

        sb.Append(Indent).Append("public function __construct(\n");
        if (fields.Count == 0)
        {
            sb.Append(Indent).Append(") {}\n");
        }
        else
        {
            for (int i = 0; i < fields.Count; i++)
            {
                var (phpType, prop, _, _, _) = fields[i];
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
            foreach (var (_, _, rhs, _, _) in fields)
            {
                sb.Append(Indent).Append(Indent).Append(rhs).Append(",\n");
            }
            sb.Append(Indent).Append(");\n");
        }

        sb.Append("}\n");

        return new EmittedFile(
            PathFor(contextName, KindFolder.ReadModels, rm.Name),
            Assemble(contextName, KindFolder.ReadModels, sb.ToString(), name,
                symbolContext.Count > 0 ? symbolContext : null),
            Kind: KindForFolder(KindFolder.ReadModels));
    }

    /// <summary>
    /// Walks <paramref name="type"/> (recursing into a <c>List</c>/<c>Set</c>/<c>Map</c>/<c>Range</c>
    /// element/value) and records, for every named model type it finds, that its <c>use</c> import
    /// must resolve against <paramref name="context"/> — the context the field's OWN declaration
    /// belongs to, not necessarily the emitting file's. A built-in scalar (<c>String</c>/<c>Int</c>/…)
    /// never needs an import and is skipped.
    /// </summary>
    private static void CollectImportHints(TypeRef type, string context, Dictionary<string, string> symbolContext)
    {
        switch (type.Name)
        {
            case "String":
            case "Int":
            case "Bool":
            case "Decimal":
            case "Instant":
            case "Uuid":
            case "Guid":
                return;
            case ModelIndex.ListTypeName:
            case ModelIndex.SetTypeName:
            case ModelIndex.RangeTypeName:
                if (type.Element is not null)
                {
                    CollectImportHints(type.Element, context, symbolContext);
                }
                return;
            case ModelIndex.MapTypeName:
                if (type.Element is not null)
                {
                    CollectImportHints(type.Element, context, symbolContext);
                }
                if (type.Value is not null)
                {
                    CollectImportHints(type.Value, context, symbolContext);
                }
                return;
            default:
                // A field's own declared type can carry an explicit `Context.Type` qualifier that
                // wins over the ambient context — the same `type.Qualifier ?? context` idiom every
                // other resolution call site in this emitter uses (e.g. PhpTypeMapper.MapBase,
                // PhpExpressionTranslator). Skipping it here would mis-hint a qualified reference.
                symbolContext[PhpNaming.ClassName(type.Name)] = type.Qualifier ?? context;
                return;
        }
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
        var resultType = typeMapper.Map(q.ResultType, contextName);

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
        WriteMethodDoc(sb, Indent, typeMapper, criteriaDocParams, null, null, contextName);

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
                var phpType = typeMapper.Map(p.Type, contextName);
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
        var resultDoc = typeMapper.DocType(q.ResultType, contextName) ?? resultType;
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
            Assemble(contextName, KindFolder.Queries, sb.ToString(), name),
            Kind: KindForFolder(KindFolder.Queries));
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
