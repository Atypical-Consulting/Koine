using System.Text;
using Koine.Compiler.Ast;

namespace Koine.Compiler.Emit.AsyncApi;

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
    /// The distinct integration events in the model, keyed and ordered by name (Ordinal) for
    /// deterministic output. An integration event is a published-language contract, so its name is
    /// the contract identity — a re-declaration of the same name in another context names the same
    /// channel/message, hence the de-duplication.
    /// </summary>
    private static IReadOnlyList<IntegrationEventDecl> CollectEvents(KoineModel model)
    {
        var byName = new SortedDictionary<string, IntegrationEventDecl>(StringComparer.Ordinal);

        // Iterate contexts in a stable (name) order, not declaration order, so that when two contexts
        // declare an integration event of the same name the winner is deterministic regardless of how
        // the sources were enumerated (directory mode merges many files into one model).
        foreach (ContextNode ctx in model.Contexts.OrderBy(c => c.Name, StringComparer.Ordinal))
        {
            foreach (IntegrationEventDecl ie in ctx.AllTypeDecls().OfType<IntegrationEventDecl>())
            {
                byName.TryAdd(ie.Name, ie);
            }
        }

        return byName.Values.ToList();
    }

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
            if (!char.IsLetterOrDigit(c) && c != '_')
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
