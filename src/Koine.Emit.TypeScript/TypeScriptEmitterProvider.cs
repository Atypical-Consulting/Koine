using Koine.Compiler.Emit;

namespace Koine.Compiler;

/// <summary>Provider for the TypeScript backend. Maps the neutral options to <see cref="TsEmitterOptions"/>.</summary>
public sealed class TypeScriptEmitterProvider : IEmitterProvider
{
    public string Target => "typescript";

    public string DisplayName => "TypeScript";

    public string FileExtension => ".ts";

    public IEmitter Create(EmitterOptions options) => new TypeScriptEmitter(ToTsOptions(options));

    /// <summary>
    /// Maps the neutral <see cref="EmitterOptions"/> to <see cref="TsEmitterOptions"/>, mirroring
    /// <see cref="CSharpEmitterProvider"/>. The shared <see cref="EmitterOptions.NamespaceMap"/> is
    /// reused as the TS module-path remap (keys are PascalCase context names, matching the module-path
    /// heads the emitter computes); <see cref="EmitterOptions.EmitSourceMaps"/> turns on the source-map
    /// sidecars. An empty bag maps to <see cref="TsEmitterOptions.Empty"/>, so an unconfigured target
    /// emits byte-identical output.
    /// </summary>
    private static TsEmitterOptions ToTsOptions(EmitterOptions options)
    {
        // A timeout-only neutral bag must NOT collapse to Empty (issue #812): the configured value has to
        // reach the `regexMatch` seam, mirroring the C# provider's guard (issue #794).
        if (options.NamespaceMap.Count == 0 && !options.EmitSourceMaps && !options.ReferenceOnly
            && options.Layers is null && options.RegexMatchTimeoutMs is null)
        {
            return TsEmitterOptions.Empty;
        }

        return new TsEmitterOptions
        {
            EmitSourceMaps = options.EmitSourceMaps,
            ModuleMap = options.NamespaceMap,
            ReferenceOnly = options.ReferenceOnly,
            Layers = ParseLayers(options.Layers),
            RegexMatchTimeoutMs = options.RegexMatchTimeoutMs,
        };
    }

    /// <summary>
    /// Parses the comma-separated <c>layers</c> selector into a <see cref="TsLayer"/> set, mirroring
    /// <see cref="CSharpEmitterProvider"/>'s parser. <c>null</c> (the default) maps to <c>null</c> ⇒
    /// Domain-only; the opt-in <c>infrastructure</c> (issue #241) always implies <c>domain</c>. Names are
    /// case-insensitive; unknown names are dropped here (the CLI rejects them up front). The TS target has
    /// no Application layer, so <c>application</c> is accepted and ignored (it still implies <c>domain</c>).
    /// </summary>
    private static IReadOnlySet<TsLayer>? ParseLayers(string? layers)
    {
        if (layers is null)
        {
            return null;
        }

        var set = new HashSet<TsLayer> { TsLayer.Domain };
        foreach (var name in layers.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            if (string.Equals(name, "infrastructure", StringComparison.OrdinalIgnoreCase))
            {
                set.Add(TsLayer.Infrastructure);
            }
        }

        return set;
    }
}
