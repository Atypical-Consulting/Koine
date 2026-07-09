using System.Text;
using Koine.Compiler.Ast;
using Koine.Compiler.Emit;
using Koine.Compiler.Services;

namespace Koine.Compiler;

/// <summary>
/// Emits a single AsyncAPI 3.0 document describing a domain's cross-boundary
/// event contracts. It reads ONLY the target-agnostic <see cref="KoineModel"/>
/// (its integration events and the context map's pub/sub graph) — no
/// <c>Emit/CSharp</c> concept leaks in — and renders deterministic YAML
/// (declaration-independent, stable ordering, no timestamps), so re-running is
/// byte-identical.
/// <para>
/// The class is split across partial files by concern: channels and messages
/// (<c>.Channels.cs</c>), payload schemas (<c>.Schemas.cs</c>), and send/receive
/// operations (<c>.Operations.cs</c>). This file owns the document envelope and
/// the section ordering.
/// </para>
/// </summary>
public sealed partial class AsyncApiEmitter : IEmitter
{
    public string TargetName => "asyncapi";

    /// <summary>The single file every emit produces.</summary>
    public const string FileName = "asyncapi.yaml";

    /// <summary>The AsyncAPI specification version this backend targets.</summary>
    private const string SpecVersion = "3.0.0";

    public IReadOnlyList<EmittedFile> Emit(KoineModel model) => Emit(model, semantic: null);

    public IReadOnlyList<EmittedFile> Emit(KoineModel model, SemanticModel? semantic)
    {
        // Reuse the shared resolution when the compiler hands one over; otherwise build our own
        // index (the type classification drives the payload schemas).
        ModelIndex index = semantic?.Index ?? new ModelIndex(model);
        var events = CollectEvents(model);

        var sb = new StringBuilder();

        sb.Append("asyncapi: ").Append(SpecVersion).Append('\n');
        sb.Append("info:\n");
        sb.Append("  title: Integration Events\n");
        sb.Append("  version: 1.0.0\n");

        // Channels and operations describe the event graph; an empty graph still emits a minimal,
        // valid document (just the two empty maps). Components hold the reusable messages and schemas.
        EmitChannels(sb, events);
        EmitOperations(sb, model, events, index);

        if (events.Count > 0)
        {
            sb.Append("components:\n");
            EmitMessages(sb, events);
            EmitSchemas(sb, events, index);
        }

        return new[] { new EmittedFile(FileName, sb.ToString()) };
    }

    /// <summary>
    /// An integration event paired with its owning context and the disambiguated <see cref="Key"/>
    /// used for its channel, message, payload schema, and operations. The key is the bare event name
    /// when that name is unique across the model, or a context-qualified <c>{Context}_{Event}</c> when
    /// two contexts declare the same name — so every emit site agrees and no context's contract is
    /// silently dropped. <see cref="Key"/> equalling <see cref="Name"/> therefore signals "no collision".
    /// </summary>
    private readonly record struct CollectedEvent(IntegrationEventDecl Event, string Context, string Key)
    {
        /// <summary>The event's simple (unqualified) name.</summary>
        public string Name => Event.Name;
    }

    /// <summary>
    /// The integration events to render, each carrying its owning context and a disambiguated channel
    /// key, ordered by that key (Ordinal) for deterministic output. An integration event is a
    /// published-language contract, so its name is normally the contract identity and the output stays
    /// unqualified. But the validator does not guarantee name uniqueness across contexts: when two
    /// contexts declare the same integration-event name (with possibly different fields), keying by the
    /// bare name would drop one context's payload shape. Such colliding names — and only those — are
    /// context-qualified, so the common single-declaration case keeps its clean, byte-identical output.
    /// </summary>
    private static IReadOnlyList<CollectedEvent> CollectEvents(KoineModel model)
    {
        // Every integration-event declaration with its owning context, gathered in a stable
        // (context-name) order so the result is declaration-independent (directory mode merges many
        // files into one model).
        var declared = new List<(string Context, IntegrationEventDecl Event)>();
        foreach (ContextNode ctx in model.Contexts.OrderBy(c => c.Name, StringComparer.Ordinal))
        {
            foreach (IntegrationEventDecl ie in ctx.AllTypeDecls().OfType<IntegrationEventDecl>())
            {
                declared.Add((ctx.Name, ie));
            }
        }

        // A simple name declared in more than one context can no longer identify a single contract by
        // its bare form: those names (and only those) are context-qualified below.
        var colliding = declared
            .GroupBy(d => d.Event.Name, StringComparer.Ordinal)
            .Where(g => g.Select(d => d.Context).Distinct(StringComparer.Ordinal).Count() > 1)
            .Select(g => g.Key)
            .ToHashSet(StringComparer.Ordinal);

        // Key each event: a non-colliding name keeps its bare form; a colliding one is qualified per
        // context, yielding one distinct entry per declaring context. Ordering by the final key keeps
        // output deterministic.
        var byKey = new SortedDictionary<string, CollectedEvent>(StringComparer.Ordinal);
        foreach (var (context, ie) in declared)
        {
            var key = ChannelKey(context, ie.Name, colliding);
            byKey.TryAdd(key, new CollectedEvent(ie, context, key));
        }

        return byKey.Values.ToList();
    }

    /// <summary>
    /// The disambiguated key for an integration event: the bare <paramref name="eventName"/> when it is
    /// unique across the model, else a context-qualified <c>{Context}_{Event}</c> when the name collides
    /// across contexts. A single helper used by every emit site so the channel, message, payload schema,
    /// and operation <c>$ref</c>s always agree.
    /// </summary>
    private static string ChannelKey(string context, string eventName, IReadOnlySet<string> colliding) =>
        colliding.Contains(eventName) ? $"{context}_{eventName}" : eventName;

    /// <summary>YAML 1.1 plain scalars that a permissive parser would coerce to a bool/null.</summary>
    private static readonly HashSet<string> YamlReservedScalars = new(StringComparer.OrdinalIgnoreCase)
    {
        "true", "false", "yes", "no", "on", "off", "null", "y", "n", "~",
    };

    /// <summary>
    /// Renders an identifier-derived scalar (enum member, channel address, tag name) for a value
    /// position: plain when unambiguous, double-quoted when it would otherwise be misread — empty, a
    /// YAML 1.1 bool/null token (e.g. <c>Off</c>, <c>Yes</c>), or carrying a non-identifier character.
    /// </summary>
    private static string YamlValue(string value) => NeedsQuoting(value) ? YamlScalar(value) : value;

    private static bool NeedsQuoting(string value)
    {
        if (value.Length == 0 || YamlReservedScalars.Contains(value))
        {
            return true;
        }

        foreach (char c in value)
        {
            if (!SourceTextGeometry.IsIdentifierChar(c))
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Renders <paramref name="text"/> as a safe single-line double-quoted YAML scalar: whitespace
    /// (incl. tabs/newlines) folded to single spaces and trimmed, backslash and quote escaped, and any
    /// remaining C0 control characters dropped — so free-form doc/summary text always stays valid YAML.
    /// </summary>
    private static string YamlScalar(string text)
    {
        var folded = text.Replace('\r', ' ').Replace('\n', ' ').Replace('\t', ' ').Trim();
        var sb = new StringBuilder(folded.Length + 2);
        sb.Append('"');
        foreach (char c in folded)
        {
            switch (c)
            {
                case '\\':
                    sb.Append("\\\\");
                    break;
                case '"':
                    sb.Append("\\\"");
                    break;
                default:
                    if (c >= 0x20)
                    {
                        sb.Append(c);
                    }

                    break;
            }
        }

        sb.Append('"');
        return sb.ToString();
    }
}
