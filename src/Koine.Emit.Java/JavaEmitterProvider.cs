using Koine.Compiler.Emit;

namespace Koine.Compiler;

/// <summary>Provider for the Java backend. Maps the neutral options to <see cref="JavaEmitterOptions"/>.</summary>
public sealed class JavaEmitterProvider : IEmitterProvider
{
    public string Target => "java";

    public string DisplayName => "Java";

    public string FileExtension => ".java";

    public IEmitter Create(EmitterOptions options) => new JavaEmitter(ToJavaOptions(options));

    /// <summary>
    /// Maps the neutral <see cref="EmitterOptions"/> to <see cref="JavaEmitterOptions"/>. The shared
    /// namespace map is reused as the Java package remap; context keys are lowercased to match the
    /// package heads the emitter computes (<c>Billing → billing</c>). A bag with neither a namespace map
    /// nor a layer selector maps to <see cref="JavaEmitterOptions.Empty"/>, so unconfigured targets emit
    /// byte-identical output — but a layers-ONLY bag must not collapse to Empty, or
    /// <c>--layers infrastructure</c> would silently do nothing (the same guard the Python/C# providers
    /// carry for their own layers/timeout keys).
    /// </summary>
    private static JavaEmitterOptions ToJavaOptions(EmitterOptions options)
    {
        if (options.NamespaceMap.Count == 0 && options.Layers is null)
        {
            return JavaEmitterOptions.Empty;
        }

        var packageMap = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var (context, package) in options.NamespaceMap)
        {
            packageMap[context.ToLowerInvariant()] = package;
        }

        return new JavaEmitterOptions(JavaEmitterOptions.DefaultBasePackage, packageMap, ParseLayers(options.Layers));
    }

    /// <summary>
    /// Parses the comma-separated <c>layers</c> selector into a <see cref="JavaLayer"/> set, mirroring the
    /// C#/Python providers' parsers. <c>null</c> (the default) maps to <c>null</c> ⇒ Domain-only; the
    /// opt-in <c>infrastructure</c> (issue #241) always implies <c>domain</c>. Names are case-insensitive;
    /// unknown names are dropped here (the CLI rejects them up front). The Java target has no separate
    /// Application layer — its application surface (services, read models, queries) is part of the domain
    /// emit — so <c>application</c> is accepted and ignored (it still implies <c>domain</c>).
    /// </summary>
    private static IReadOnlySet<JavaLayer>? ParseLayers(string? layers)
    {
        if (layers is null)
        {
            return null;
        }

        var set = new HashSet<JavaLayer> { JavaLayer.Domain };
        foreach (var name in layers.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            if (string.Equals(name, "infrastructure", StringComparison.OrdinalIgnoreCase))
            {
                set.Add(JavaLayer.Infrastructure);
            }
        }

        return set;
    }
}
