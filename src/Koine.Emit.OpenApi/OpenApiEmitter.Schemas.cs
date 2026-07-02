using Koine.Compiler.Ast;

namespace Koine.Compiler;

/// <summary>
/// The <c>components/schemas</c> layer of the OpenAPI emitter: value objects, read models, and enums
/// become named JSON Schema (2020-12, the dialect OpenAPI 3.1 aligns with) entries. Primitives map to
/// their JSON types, optional members render as a <c>"null"</c> type-union (the 3.1-correct nullability),
/// nested value objects / enums / read models become <c>$ref</c>s, collections become <c>array</c>s, and
/// smart enums lower to a string <c>enum</c> of their member names. Entities and aggregates are NOT
/// surfaced as schemas (they are behavioral, reached through the path layer); a reference to one — or to
/// any type this context does not emit — degrades to an opaque <c>{ type: object }</c> so the document
/// never carries a dangling <c>$ref</c>.
/// </summary>
public sealed partial class OpenApiEmitter
{
    /// <summary>The <c>components</c> object: the <c>schemas</c> map, omitted entirely when the context has none.</summary>
    private static YamlObject BuildComponents(ContextNode ctx, ModelIndex index)
    {
        var components = new YamlObject();
        YamlObject schemas = BuildSchemas(ctx, index);
        if (!schemas.IsEmpty)
        {
            components.Add("schemas", schemas);
        }

        return components;
    }

    /// <summary>
    /// Builds the named schema map for a context: one entry per value object, read model, and enum,
    /// in a stable (ordinal-by-name) order so Verify snapshots are reproducible regardless of the
    /// declaration/nesting walk.
    /// </summary>
    private static YamlObject BuildSchemas(ContextNode ctx, ModelIndex index)
    {
        var emitted = SchemaTypeNames(ctx);
        var schemas = new YamlObject();

        foreach (TypeDecl type in SchemaTypes(ctx).OrderBy(t => t.Name, StringComparer.Ordinal))
        {
            switch (type)
            {
                case EnumDecl en:
                    schemas.Add(en.Name, EnumSchema(en));
                    break;
                case ValueObjectDecl vo:
                    schemas.Add(vo.Name, ValueObjectSchema(vo, index, emitted));
                    break;
                case ReadModelDecl rm:
                    schemas.Add(rm.Name, ReadModelSchema(rm, index, emitted));
                    break;
            }
        }

        return schemas;
    }

    /// <summary>The value-object / read-model / enum declarations of a context (flattened through aggregates).</summary>
    private static IEnumerable<TypeDecl> SchemaTypes(ContextNode ctx) =>
        ctx.AllTypeDecls().Where(t => t is ValueObjectDecl or ReadModelDecl or EnumDecl);

    /// <summary>The set of type names this context emits as a named schema — the legal <c>$ref</c> targets.</summary>
    private static HashSet<string> SchemaTypeNames(ContextNode ctx) =>
        SchemaTypes(ctx).Select(t => t.Name).ToHashSet(StringComparer.Ordinal);

    /// <summary>A smart/plain enum → a string schema whose <c>enum</c> lists the member names in declaration order.</summary>
    private static YamlObject EnumSchema(EnumDecl en)
    {
        var schema = new YamlObject();
        schema.Add("type", "string");
        if (!string.IsNullOrWhiteSpace(en.Doc))
        {
            schema.Add("description", OneLine(en.Doc!));
        }

        var values = new YamlArray();
        foreach (string name in en.MemberNames)
        {
            values.Add(Yaml.Str(name));
        }

        schema.Add("enum", values);
        return schema;
    }

    /// <summary>A value object → an <c>object</c> schema: one property per member, non-optional members required.</summary>
    private static YamlObject ValueObjectSchema(ValueObjectDecl vo, ModelIndex index, HashSet<string> emitted)
    {
        var keywords = LowerInvariants(vo);
        return ObjectSchema(
            vo.Doc,
            vo.Members.Select(m => (m.Name, m.Type, m.Doc, Keywords: Lookup(keywords, m.Name))),
            index,
            emitted);
    }

    /// <summary>A read model → an <c>object</c> schema; direct fields resolve their type from the source member.</summary>
    private static YamlObject ReadModelSchema(ReadModelDecl rm, ModelIndex index, HashSet<string> emitted)
    {
        var fields = new List<(string Name, TypeRef Type, string? Doc, IReadOnlyList<KeyValuePair<string, Yaml>>? Keywords)>();
        foreach (ReadModelField field in rm.Fields)
        {
            // A direct field (no declared type) maps to the source member of the same name; a derived
            // field carries its own declared type. When a direct field cannot be resolved (e.g. it
            // names an identity), fall back to an opaque string so the schema stays valid.
            TypeRef type = field.Type
                ?? (index.TryGetMemberType(rm.SourceType, field.Name, out TypeRef resolved)
                    ? resolved
                    : new TypeRef("String"));
            fields.Add((field.Name, type, field.Doc, null));
        }

        return ObjectSchema(rm.Doc, fields, index, emitted);
    }

    /// <summary>Shared <c>object</c>-schema builder: properties (with optional per-member keywords) + a required list.</summary>
    private static YamlObject ObjectSchema(
        string? doc,
        IEnumerable<(string Name, TypeRef Type, string? Doc, IReadOnlyList<KeyValuePair<string, Yaml>>? Keywords)> members,
        ModelIndex index,
        HashSet<string> emitted)
    {
        var schema = new YamlObject();
        schema.Add("type", "object");
        if (!string.IsNullOrWhiteSpace(doc))
        {
            schema.Add("description", OneLine(doc!));
        }

        var properties = new YamlObject();
        var required = new YamlArray();
        foreach (var (name, type, memberDoc, keywords) in members)
        {
            properties.Add(name, PropertySchema(type, memberDoc, keywords, index, emitted));
            if (!type.IsOptional)
            {
                required.Add(Yaml.Str(name));
            }
        }

        schema.Add("properties", properties);
        if (!required.IsEmpty)
        {
            schema.Add("required", required);
        }

        return schema;
    }

    /// <summary>A property schema: the member's type schema, plus its doc and any invariant-derived keywords.</summary>
    private static YamlObject PropertySchema(
        TypeRef type,
        string? doc,
        IReadOnlyList<KeyValuePair<string, Yaml>>? keywords,
        ModelIndex index,
        HashSet<string> emitted)
    {
        YamlObject schema = SchemaForType(type, index, emitted);
        if (!string.IsNullOrWhiteSpace(doc))
        {
            schema.Add("description", OneLine(doc!));
        }

        if (keywords is not null)
        {
            foreach (var (key, value) in keywords)
            {
                schema.Add(key, value);
            }
        }

        return schema;
    }

    /// <summary>Maps a Koine <see cref="TypeRef"/> to its JSON Schema, applying 3.1 nullability when optional.</summary>
    private static YamlObject SchemaForType(TypeRef type, ModelIndex index, HashSet<string> emitted)
    {
        YamlObject schema = BaseSchema(type, index, emitted);
        return type.IsOptional ? MakeNullable(schema) : schema;
    }

    /// <summary>The non-nullable core schema for a type reference.</summary>
    private static YamlObject BaseSchema(TypeRef type, ModelIndex index, HashSet<string> emitted)
    {
        switch (type.Name)
        {
            case "String":
                return Scalar("string");
            case "Int":
                return Scalar("integer", "int32");
            case "Decimal":
                return Scalar("number");
            case "Bool":
                return Scalar("boolean");
            case "Instant":
                return Scalar("string", "date-time");

            case ModelIndex.ListTypeName:
                return Array(type.Element, index, emitted, unique: false);
            case ModelIndex.SetTypeName:
                return Array(type.Element, index, emitted, unique: true);
            case ModelIndex.MapTypeName:
                {
                    // A Map<K,V> projects to a JSON object keyed by string with V-typed values.
                    var map = new YamlObject();
                    map.Add("type", "object");
                    map.Add("additionalProperties", type.Value is { } value
                        ? SchemaForType(value, index, emitted)
                        : new YamlObject().Add("type", "object"));
                    return map;
                }

            default:
                // A type we emit as a named schema in THIS context → a local $ref. An ID value object
                // wraps a Guid. Anything else (a cross-context reference, an entity, an aggregate) has
                // no local schema, so degrade to an opaque object rather than emit a dangling $ref.
                if (emitted.Contains(type.Name))
                {
                    return Ref(type.Name);
                }

                if (index.Classify(type.Name) == TypeKind.IdValueObject)
                {
                    return Scalar("string", "uuid");
                }

                return new YamlObject().Add("type", "object");
        }
    }

    private static YamlObject Array(TypeRef? element, ModelIndex index, HashSet<string> emitted, bool unique)
    {
        var schema = new YamlObject();
        schema.Add("type", "array");
        schema.Add("items", element is not null
            ? SchemaForType(element, index, emitted)
            : new YamlObject().Add("type", "object"));
        if (unique)
        {
            schema.Add("uniqueItems", Yaml.Bool(true));
        }

        return schema;
    }

    private static YamlObject Scalar(string jsonType, string? format = null)
    {
        var schema = new YamlObject();
        schema.Add("type", jsonType);
        if (format is not null)
        {
            schema.Add("format", format);
        }

        return schema;
    }

    private static YamlObject Ref(string schemaName) =>
        new YamlObject().Add("$ref", $"#/components/schemas/{schemaName}");

    /// <summary>
    /// Wraps a schema so it also admits <c>null</c>, the OpenAPI 3.1 way: a scalar <c>type</c> becomes a
    /// <c>[type, "null"]</c> union; a <c>$ref</c> becomes <c>anyOf: [ref, {type: null}]</c> (a <c>$ref</c>
    /// cannot carry sibling keywords).
    /// </summary>
    private static YamlObject MakeNullable(YamlObject schema)
    {
        IReadOnlyList<KeyValuePair<string, Yaml>> entries = schema.Entries;
        if (entries.Count == 1 && entries[0].Key == "$ref")
        {
            var anyOf = new YamlArray();
            anyOf.Add(schema);
            anyOf.Add(new YamlObject().Add("type", "null"));
            return new YamlObject().Add("anyOf", anyOf);
        }

        var nullable = new YamlObject();
        foreach (var (key, value) in entries)
        {
            if (key == "type" && value is YamlScalar scalar)
            {
                var union = new YamlArray();
                union.Add(Yaml.Raw(scalar.Text));
                union.Add(Yaml.Str("null"));
                nullable.Add("type", union);
            }
            else
            {
                nullable.Add(key, value);
            }
        }

        return nullable;
    }

    private static IReadOnlyList<KeyValuePair<string, Yaml>>? Lookup(
        IReadOnlyDictionary<string, List<KeyValuePair<string, Yaml>>> keywords, string member) =>
        keywords.TryGetValue(member, out List<KeyValuePair<string, Yaml>>? value) ? value : null;

    /// <summary>
    /// Best-effort lowering of static value-object invariants to JSON-Schema validation keywords, keyed
    /// by the member each constrains. Recognises bounds whose shape is a comparison of a DIRECT member
    /// access against a literal — <c>code.length &lt;= 12</c> → <c>maxLength</c>, <c>amount &gt;= 1</c> →
    /// <c>minimum</c>, <c>items.count &gt;= 1</c> → <c>minItems</c> — and a <c>matches /re/</c> →
    /// <c>pattern</c>. An <c>&amp;&amp;</c> of bounds lowers each side. Anything else — a guarded
    /// invariant, a transformed receiver (<c>code.trim.length</c>), a cross-member or non-literal
    /// expression — is silently dropped, because the schema is an approximation of the model, never the
    /// other way round. Keywords are emitted in a fixed precedence order so output is stable regardless
    /// of invariant declaration order.
    /// </summary>
    private static IReadOnlyDictionary<string, List<KeyValuePair<string, Yaml>>> LowerInvariants(ValueObjectDecl vo)
    {
        var members = vo.Members.Select(m => m.Name).ToHashSet(StringComparer.Ordinal);
        var byMember = new Dictionary<string, List<KeyValuePair<string, Yaml>>>(StringComparer.Ordinal);

        foreach (Invariant invariant in vo.Invariants)
        {
            foreach (var (member, keyword, value) in LowerCondition(invariant.Condition, members))
            {
                if (!byMember.TryGetValue(member, out List<KeyValuePair<string, Yaml>>? list))
                {
                    byMember[member] = list = [];
                }

                // First invariant to set a keyword wins; a later duplicate of the same keyword is ignored.
                if (!list.Any(kv => kv.Key == keyword))
                {
                    list.Add(new KeyValuePair<string, Yaml>(keyword, value));
                }
            }
        }

        foreach (List<KeyValuePair<string, Yaml>> list in byMember.Values)
        {
            list.Sort((a, b) => KeywordRank(a.Key).CompareTo(KeywordRank(b.Key)));
        }

        return byMember;
    }

    /// <summary>Lowers one invariant condition (descending through <c>&amp;&amp;</c>) to zero or more member keywords.</summary>
    private static IEnumerable<(string Member, string Keyword, Yaml Value)> LowerCondition(Expr condition, HashSet<string> members)
    {
        switch (condition)
        {
            case BinaryExpr { Op: BinaryOp.And } conjunction:
                foreach (var keyword in LowerCondition(conjunction.Left, members))
                {
                    yield return keyword;
                }

                foreach (var keyword in LowerCondition(conjunction.Right, members))
                {
                    yield return keyword;
                }

                break;

            case MatchExpr match when DirectMember(match.Target, members) is { } member:
                yield return (member, "pattern", Yaml.Str(match.Pattern));
                break;

            case BinaryExpr comparison when LowerComparison(comparison, members) is { } lowered:
                yield return lowered;
                break;
        }
    }

    /// <summary>Lowers a single <c>member &lt;op&gt; literal</c> comparison (operands either way round) to a keyword.</summary>
    private static (string Member, string Keyword, Yaml Value)? LowerComparison(BinaryExpr comparison, HashSet<string> members)
    {
        // Normalise so the member-bearing operand is on the left and the literal on the right, flipping
        // the operator when the literal was written first (`100 >= amount` ⇒ `amount <= 100`).
        BinaryOp op;
        Expr operand;
        LiteralExpr literal;
        if (comparison.Right is LiteralExpr right)
        {
            (op, operand, literal) = (comparison.Op, comparison.Left, right);
        }
        else if (comparison.Left is LiteralExpr left)
        {
            (op, operand, literal) = (Flip(comparison.Op), comparison.Right, left);
        }
        else
        {
            return null;
        }

        // A string length bound: `member.length <op> intLiteral`.
        if (DirectAccess(operand, members, "length") is { } lengthMember && IntValue(literal) is { } length)
        {
            return op switch
            {
                BinaryOp.Le => (lengthMember, "maxLength", Yaml.Int(length)),
                BinaryOp.Lt => (lengthMember, "maxLength", Yaml.Int(length - 1)),
                BinaryOp.Ge => (lengthMember, "minLength", Yaml.Int(length)),
                BinaryOp.Gt => (lengthMember, "minLength", Yaml.Int(length + 1)),
                _ => null,
            };
        }

        // A collection size bound: `member.count <op> intLiteral`.
        if (DirectAccess(operand, members, "count") is { } countMember && IntValue(literal) is { } size)
        {
            return op switch
            {
                BinaryOp.Le => (countMember, "maxItems", Yaml.Int(size)),
                BinaryOp.Lt => (countMember, "maxItems", Yaml.Int(size - 1)),
                BinaryOp.Ge => (countMember, "minItems", Yaml.Int(size)),
                BinaryOp.Gt => (countMember, "minItems", Yaml.Int(size + 1)),
                _ => null,
            };
        }

        // A numeric bound on the member itself: `member <op> numericLiteral`.
        if (DirectMember(operand, members) is { } numericMember && NumericText(literal) is { } number)
        {
            return op switch
            {
                BinaryOp.Ge => (numericMember, "minimum", Yaml.Raw(number)),
                BinaryOp.Gt => (numericMember, "exclusiveMinimum", Yaml.Raw(number)),
                BinaryOp.Le => (numericMember, "maximum", Yaml.Raw(number)),
                BinaryOp.Lt => (numericMember, "exclusiveMaximum", Yaml.Raw(number)),
                _ => null,
            };
        }

        return null;
    }

    /// <summary>The member named by a bare identifier reference, or <c>null</c> if it is not a direct member.</summary>
    private static string? DirectMember(Expr expr, HashSet<string> members) =>
        expr is IdentifierExpr id && members.Contains(id.Name) ? id.Name : null;

    /// <summary>The member behind a direct no-arg access (<c>member.length</c>/<c>member.count</c>), no transforms between.</summary>
    private static string? DirectAccess(Expr expr, HashSet<string> members, string op) =>
        expr is MemberAccessExpr access && access.MemberName == op ? DirectMember(access.Target, members) : null;

    private static int? IntValue(LiteralExpr literal) =>
        literal.Kind == LiteralKind.Int && int.TryParse(literal.Text, out int value) ? value : null;

    private static string? NumericText(LiteralExpr literal) =>
        literal.Kind is LiteralKind.Int or LiteralKind.Decimal ? literal.Text : null;

    /// <summary>Reverses a comparison operator so a literal-first comparison can be read member-first.</summary>
    private static BinaryOp Flip(BinaryOp op) => op switch
    {
        BinaryOp.Lt => BinaryOp.Gt,
        BinaryOp.Le => BinaryOp.Ge,
        BinaryOp.Gt => BinaryOp.Lt,
        BinaryOp.Ge => BinaryOp.Le,
        _ => op,
    };

    /// <summary>A fixed precedence for validation keywords so a property's lowered keywords emit in stable order.</summary>
    private static int KeywordRank(string keyword) => keyword switch
    {
        "minLength" => 0,
        "maxLength" => 1,
        "pattern" => 2,
        "minimum" => 3,
        "maximum" => 4,
        "exclusiveMinimum" => 5,
        "exclusiveMaximum" => 6,
        "minItems" => 7,
        "maxItems" => 8,
        _ => 99,
    };
}
