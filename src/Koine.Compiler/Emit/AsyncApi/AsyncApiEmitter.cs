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

    public IReadOnlyList<EmittedFile> Emit(KoineModel model)
    {
        var sb = new StringBuilder();

        sb.Append("asyncapi: ").Append(SpecVersion).Append('\n');
        sb.Append("info:\n");
        sb.Append("  title: Integration Events\n");
        sb.Append("  version: 1.0.0\n");

        // Channels, operations and components are filled by the partial slices once a model
        // carries integration events; an empty graph still emits a minimal, valid document.
        sb.Append("channels: {}\n");
        sb.Append("operations: {}\n");

        return new[] { new EmittedFile(FileName, sb.ToString()) };
    }
}
