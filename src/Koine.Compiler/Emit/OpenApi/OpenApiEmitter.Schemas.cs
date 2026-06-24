using Koine.Compiler.Ast;

namespace Koine.Compiler.Emit.OpenApi;

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
        AllTypes(ctx.Types).Where(t => t is ValueObjectDecl or ReadModelDecl or EnumDecl);

    /// <summary>The set of type names this context emits as a named schema — the legal <c>$ref</c> targets.</summary>
    private static HashSet<string> SchemaTypeNames(ContextNode ctx) =>
        SchemaTypes(ctx).Select(t => t.Name).ToHashSet(StringComparer.Ordinal);

    /// <summary>Every type declaration in a context, descending into aggregate-nested types.</summary>
    private static IEnumerable<TypeDecl> AllTypes(IEnumerable<TypeDecl> types)
    {
        foreach (TypeDecl type in types)
        {
            yield return type;
            if (type is AggregateDecl agg)
            {
                foreach (TypeDecl nested in AllTypes(agg.Types))
                {
                    yield return nested;
                }
            }
        }
    }

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
    /// Lowers static value-object invariants to JSON-Schema validation keywords, keyed by the member
    /// each constrains. Task 2 ships the empty map (no lowering); the invariant→keyword pass lands in
    /// Task 4 (see <c>.Schemas.cs</c>'s <c>LowerInvariants</c> implementation).
    /// </summary>
    private static IReadOnlyDictionary<string, List<KeyValuePair<string, Yaml>>> LowerInvariants(ValueObjectDecl vo) =>
        new Dictionary<string, List<KeyValuePair<string, Yaml>>>(StringComparer.Ordinal);
}
