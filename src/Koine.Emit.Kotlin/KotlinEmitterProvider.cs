using Koine.Compiler.Emit;

namespace Koine.Compiler;

/// <summary>Provider for the Kotlin backend. Maps the neutral options to <see cref="KotlinEmitterOptions"/>.</summary>
public sealed class KotlinEmitterProvider : IEmitterProvider
{
    public string Target => "kotlin";

    public string DisplayName => "Kotlin";

    public string FileExtension => ".kt";

    public IEmitter Create(EmitterOptions options) => new KotlinEmitter(ToKotlinOptions(options));

    /// <summary>
    /// Maps the neutral <see cref="EmitterOptions"/> to <see cref="KotlinEmitterOptions"/>. The shared
    /// namespace map is reused as the Kotlin package remap; context keys are lowercased to match the
    /// package heads the emitter computes (<c>Billing → billing</c>). An empty bag maps to
    /// <see cref="KotlinEmitterOptions.Empty"/>, so unconfigured targets emit byte-identical output.
    /// </summary>
    private static KotlinEmitterOptions ToKotlinOptions(EmitterOptions options)
    {
        if (options.NamespaceMap.Count == 0)
        {
            return KotlinEmitterOptions.Empty;
        }

        var packageMap = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var (context, package) in options.NamespaceMap)
        {
            packageMap[context.ToLowerInvariant()] = package;
        }

        return new KotlinEmitterOptions(KotlinEmitterOptions.DefaultBasePackage, packageMap);
    }
}
