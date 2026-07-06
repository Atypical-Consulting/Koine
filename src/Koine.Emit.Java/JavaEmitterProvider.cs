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
    /// package heads the emitter computes (<c>Billing → billing</c>). An empty bag maps to
    /// <see cref="JavaEmitterOptions.Empty"/>, so unconfigured targets emit byte-identical output.
    /// </summary>
    private static JavaEmitterOptions ToJavaOptions(EmitterOptions options)
    {
        if (options.NamespaceMap.Count == 0)
        {
            return JavaEmitterOptions.Empty;
        }

        var packageMap = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var (context, package) in options.NamespaceMap)
        {
            packageMap[context.ToLowerInvariant()] = package;
        }

        return new JavaEmitterOptions(JavaEmitterOptions.DefaultBasePackage, packageMap);
    }
}
