using System.Text;
using Koine.Compiler.Ast;

namespace Koine.Compiler.Emit.AsyncApi;

/// <summary>
/// Schemas slice of the AsyncAPI emitter: renders one <c>&lt;Event&gt;Payload</c> JSON-Schema per
/// integration event from its fields. Primitives map to their JSON-Schema type, enums inline a
/// <c>string</c> with an <c>enum:</c> list, ID value objects are shared <c>string</c> schemas
/// referenced by <c>$ref</c>, and a nested integration-event field references that event's payload.
/// </summary>
public sealed partial class AsyncApiEmitter
{
    /// <summary>
    /// Emits the <c>components/schemas</c> map: a payload schema per event (in the events' stable
    /// order), followed by the shared ID value-object schemas the payloads referenced (sorted).
    /// </summary>
    private static void EmitSchemas(StringBuilder sb, IReadOnlyList<CollectedEvent> events, ModelIndex index)
    {
        sb.Append("  schemas:\n");

        // ID value objects recur across events, so they are emitted once as shared schemas and
        // referenced by $ref; collected here as the payloads are rendered.
        var sharedIds = new SortedSet<string>(StringComparer.Ordinal);

        foreach (CollectedEvent ev in events)
        {
            IntegrationEventDecl ie = ev.Event;
            sb.Append("    ").Append(ev.Key).Append("Payload:\n");
            sb.Append("      type: object\n");

            if (ie.Members.Count == 0)
            {
                continue;
            }

            sb.Append("      properties:\n");
            foreach (Member m in ie.Members)
            {
                sb.Append("        ").Append(m.Name).Append(":\n");
                EmitTypeRef(sb, m.Type, index, sharedIds, indent: "          ");
            }

            var required = ie.Members.Where(m => !m.Type.IsOptional).Select(m => m.Name).ToList();
            if (required.Count > 0)
            {
                sb.Append("      required:\n");
                foreach (var name in required)
                {
                    sb.Append("        - ").Append(name).Append('\n');
                }
            }
        }

        foreach (var id in sharedIds)
        {
            sb.Append("    ").Append(id).Append(":\n");
            sb.Append("      type: string\n");
        }
    }

    /// <summary>
    /// Renders the JSON-Schema body for one field type at <paramref name="indent"/>: a primitive's
    /// type/format, an inline string enum, a <c>$ref</c> to a shared ID schema or a nested event's
    /// payload, or the structural shape of a collection field (list/set → array, map → object,
    /// range → a min/max object). Recurses into element/value types so nested IDs still register.
    /// </summary>
    private static void EmitTypeRef(StringBuilder sb, TypeRef type, ModelIndex index, SortedSet<string> sharedIds, string indent)
    {
        switch (index.Classify(type.Name))
        {
            case TypeKind.List:
                sb.Append(indent).Append("type: array\n");
                sb.Append(indent).Append("items:\n");
                EmitTypeRef(sb, type.Element!, index, sharedIds, indent + "  ");
                break;

            case TypeKind.Set:
                // A set is an array whose items are unique.
                sb.Append(indent).Append("type: array\n");
                sb.Append(indent).Append("uniqueItems: true\n");
                sb.Append(indent).Append("items:\n");
                EmitTypeRef(sb, type.Element!, index, sharedIds, indent + "  ");
                break;

            case TypeKind.Map:
                // JSON-Schema object keys are always strings, so a map is an object whose values
                // (the map's value type) are described by additionalProperties.
                sb.Append(indent).Append("type: object\n");
                sb.Append(indent).Append("additionalProperties:\n");
                EmitTypeRef(sb, type.Value!, index, sharedIds, indent + "  ");
                break;

            case TypeKind.Range:
                // A range is a { min, max } pair of its element type.
                sb.Append(indent).Append("type: object\n");
                sb.Append(indent).Append("properties:\n");
                sb.Append(indent).Append("  min:\n");
                EmitTypeRef(sb, type.Element!, index, sharedIds, indent + "    ");
                sb.Append(indent).Append("  max:\n");
                EmitTypeRef(sb, type.Element!, index, sharedIds, indent + "    ");
                break;

            case TypeKind.Enum:
                sb.Append(indent).Append("type: string\n");
                if (index.TryGetDecl(type.Name, out TypeDecl decl) && decl is EnumDecl en)
                {
                    sb.Append(indent).Append("enum:\n");
                    foreach (var member in en.MemberNames)
                    {
                        sb.Append(indent).Append("  - ").Append(YamlValue(member)).Append('\n');
                    }
                }

                break;

            case TypeKind.IdValueObject:
                sharedIds.Add(type.Name);
                sb.Append(indent).Append("$ref: '#/components/schemas/").Append(type.Name).Append("'\n");
                break;

            case TypeKind.IntegrationEvent:
                sb.Append(indent).Append("$ref: '#/components/schemas/").Append(type.Name).Append("Payload'\n");
                break;

            default:
                EmitPrimitive(sb, type.Name, indent);
                break;
        }
    }

    /// <summary>
    /// Maps a Koine primitive to its JSON-Schema type. <c>Decimal</c> is a <c>string</c> to preserve
    /// precision (matching the other Koine emitters); <c>Instant</c> is an ISO-8601 <c>date-time</c>.
    /// An unexpected scalar (integration-event fields are restricted, so this is effectively
    /// unreachable for a valid model) falls back to a permissive <c>string</c>.
    /// </summary>
    private static void EmitPrimitive(StringBuilder sb, string name, string indent)
    {
        switch (name)
        {
            case "Int":
                sb.Append(indent).Append("type: integer\n");
                break;
            case "Bool":
                sb.Append(indent).Append("type: boolean\n");
                break;
            case "Instant":
                sb.Append(indent).Append("type: string\n");
                sb.Append(indent).Append("format: date-time\n");
                break;
            default: // String, Decimal, and any unexpected scalar.
                sb.Append(indent).Append("type: string\n");
                break;
        }
    }
}
