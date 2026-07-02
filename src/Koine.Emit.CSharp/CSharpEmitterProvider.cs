using Koine.Compiler.Emit.CSharp;

namespace Koine.Compiler.Emit;

/// <summary>Provider for the C# backend. Maps the neutral options to <see cref="CSharpEmitterOptions"/>.</summary>
public sealed class CSharpEmitterProvider : IEmitterProvider
{
    public string Target => "csharp";

    public string DisplayName => "C#";

    public string FileExtension => ".cs";

    public IEmitter Create(EmitterOptions options) => new CSharpEmitter(ToCSharpOptions(options));

    /// <summary>
    /// Maps the neutral <see cref="EmitterOptions"/> to <see cref="CSharpEmitterOptions"/> (R16.1).
    /// An empty bag maps to <see cref="CSharpEmitterOptions.Empty"/>, so an unconfigured target emits
    /// byte-identical output. <c>instantMode = nodaTime</c> (case-insensitive) selects the NodaTime
    /// mode; anything else (incl. <c>dateTimeOffset</c> and absent) keeps the DateTimeOffset default.
    /// The <c>layout</c> key is accepted and currently a no-op (file-per-type is the only layout).
    /// <c>regexMode = sourceGenerated</c> (case-insensitive) selects the <c>[GeneratedRegex]</c> form
    /// (issue #831); anything else (incl. <c>inline</c> and absent) keeps the inline default. Both
    /// absent/inline treat <see cref="EmitterOptions.RegexMode"/> as unset, so an unconfigured target
    /// still maps to <see cref="CSharpEmitterOptions.Empty"/> when no other option is set.
    /// </summary>
    private static CSharpEmitterOptions ToCSharpOptions(EmitterOptions options)
    {
        var isSourceGeneratedRegex = string.Equals(
            options.RegexMode, "sourceGenerated", StringComparison.OrdinalIgnoreCase);

        if (options.NamespaceMap.Count == 0 && options.InstantMode is null && !options.EmitSourceMaps
            && !options.ReferenceOnly && options.Layers is null
            && !options.ApplicationMediatr && options.ApplicationMapping is null
            && options.RegexMatchTimeoutMs is null && !isSourceGeneratedRegex)
        {
            return CSharpEmitterOptions.Empty;
        }

        var instant = string.Equals(options.InstantMode, "nodaTime", StringComparison.OrdinalIgnoreCase)
            ? CSharpInstantMode.NodaTime
            : CSharpInstantMode.DateTimeOffset;
        var mapping = string.Equals(options.ApplicationMapping, "mapperly", StringComparison.OrdinalIgnoreCase)
            ? CSharpMappingMode.Mapperly
            : CSharpMappingMode.Plain;
        var regexMode = isSourceGeneratedRegex ? RegexMode.SourceGenerated : RegexMode.Inline;
        return new CSharpEmitterOptions(
            options.NamespaceMap, instant, options.EmitSourceMaps, options.ReferenceOnly,
            ParseLayers(options.Layers), options.ApplicationMediatr, mapping,
            options.RegexMatchTimeoutMs ?? 1000, regexMode);
    }

    /// <summary>
    /// Parses the comma-separated <c>layers</c> selector into a layer set. <c>null</c> (the default)
    /// maps to <c>null</c> ⇒ Domain-only. Both opt-in layers imply <c>domain</c>: <c>application</c>
    /// (issue #129) and <c>infrastructure</c> (issue #128, the EF Core realization of the contracts).
    /// Names are case-insensitive; unknown names are dropped here (the CLI rejects them up front).
    /// </summary>
    private static IReadOnlySet<CSharpLayer>? ParseLayers(string? layers)
    {
        if (layers is null)
        {
            return null;
        }

        var set = new HashSet<CSharpLayer> { CSharpLayer.Domain };
        foreach (var name in layers.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            if (string.Equals(name, "application", StringComparison.OrdinalIgnoreCase))
            {
                set.Add(CSharpLayer.Application);
            }
            else if (string.Equals(name, "infrastructure", StringComparison.OrdinalIgnoreCase))
            {
                set.Add(CSharpLayer.Infrastructure);
            }
        }

        return set;
    }
}
