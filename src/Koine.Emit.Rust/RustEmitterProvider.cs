using Koine.Compiler.Emit;

namespace Koine.Compiler;

/// <summary>Provider for the Rust backend. Maps the neutral options to <see cref="RustEmitterOptions"/>.</summary>
public sealed class RustEmitterProvider : IEmitterProvider
{
    public string Target => "rust";

    public string DisplayName => "Rust";

    public string FileExtension => ".rs";

    public IEmitter Create(EmitterOptions options) => new RustEmitter(ToRustOptions(options));

    /// <summary>
    /// Maps the neutral <see cref="EmitterOptions"/> to <see cref="RustEmitterOptions"/>. The shared
    /// namespace map is reused as the Rust module remap; context keys are <c>snake_case</c>d to match
    /// the module heads the emitter computes (<c>Billing → billing</c>). An empty bag maps to
    /// <see cref="RustEmitterOptions.Empty"/>, so unconfigured targets emit byte-identical output.
    /// </summary>
    private static RustEmitterOptions ToRustOptions(EmitterOptions options)
    {
        if (options.NamespaceMap.Count == 0)
        {
            return RustEmitterOptions.Empty;
        }

        var moduleMap = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var (context, module) in options.NamespaceMap)
        {
            moduleMap[RustNaming.ToSnakeCase(context)] = module;
        }

        return new RustEmitterOptions(moduleMap);
    }
}
