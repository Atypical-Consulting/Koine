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
        foreach (ContextNode ctx in model.Contexts)
        {
            foreach (IntegrationEventDecl ie in ctx.AllTypeDecls().OfType<IntegrationEventDecl>())
            {
                byName.TryAdd(ie.Name, ie);
            }
        }

        return byName.Values.ToList();
    }

    /// <summary>
    /// Renders <paramref name="text"/> as a safe single-line YAML scalar: folded to one line and
    /// double-quoted with the minimal escapes, so doc/summary text carrying YAML metacharacters
    /// (<c>:</c>, <c>#</c>, …) stays valid.
    /// </summary>
    private static string YamlScalar(string text)
    {
        var folded = text.Replace('\r', ' ').Replace('\n', ' ').Trim();
        var escaped = folded.Replace("\\", "\\\\").Replace("\"", "\\\"");
        return "\"" + escaped + "\"";
    }
}
