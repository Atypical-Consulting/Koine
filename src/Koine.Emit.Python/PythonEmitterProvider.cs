using Koine.Compiler.Emit.Python;

namespace Koine.Compiler.Emit;

/// <summary>Provider for the Python backend. Maps the neutral options to <see cref="PythonEmitterOptions"/>.</summary>
public sealed class PythonEmitterProvider : IEmitterProvider
{
    public string Target => "python";

    public string DisplayName => "Python";

    public string FileExtension => ".py";

    public IEmitter Create(EmitterOptions options) => new PythonEmitter(ToPythonOptions(options));

    /// <summary>
    /// Maps the neutral <see cref="EmitterOptions"/> to <see cref="PythonEmitterOptions"/>. The shared
    /// namespace map is reused as the Python package remap; there is no neutral key for
    /// <c>EmitDictHelpers</c>, so it stays at the default <c>false</c>. An empty bag maps to
    /// <see cref="PythonEmitterOptions.Empty"/>, so unconfigured targets emit byte-identical output.
    /// <para>
    /// The context keys are <c>snake_case</c>d here so they match the heads the emitter computes:
    /// <see cref="PythonEmitterOptions.RemapPackage"/> looks up an already-lowered package head
    /// (<c>Catalog → catalog</c>), so a key written as the user names the context (<c>Catalog</c>)
    /// would otherwise never match. (The C# provider needs no such step: C# namespace heads stay
    /// PascalCase, matching the config key as written.)
    /// </para>
    /// </summary>
    private static PythonEmitterOptions ToPythonOptions(EmitterOptions options)
    {
        // A timeout-only neutral bag must NOT collapse to Empty (issue #812): the configured value has to
        // reach the Python `matches` lowering, mirroring the C# provider's guard (issue #794).
        if (options.NamespaceMap.Count == 0 && options.Layers is null && options.RegexMatchTimeoutMs is null)
        {
            return PythonEmitterOptions.Empty;
        }

        var packageMap = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var (context, package) in options.NamespaceMap)
        {
            packageMap[PythonNaming.ToSnakeCase(context)] = package;
        }

        return new PythonEmitterOptions(
            packageMap, EmitDictHelpers: false, ParseLayers(options.Layers), options.RegexMatchTimeoutMs);
    }

    /// <summary>
    /// Parses the comma-separated <c>layers</c> selector into a <see cref="PythonLayer"/> set, mirroring
    /// <see cref="CSharpEmitterProvider"/>'s parser. <c>null</c> (the default) maps to <c>null</c> ⇒
    /// Domain-only; the opt-in <c>infrastructure</c> (issue #241) always implies <c>domain</c>. Names are
    /// case-insensitive; unknown names are dropped here (the CLI rejects them up front). The Python target
    /// has no Application layer, so <c>application</c> is accepted and ignored (it still implies <c>domain</c>).
    /// </summary>
    private static IReadOnlySet<PythonLayer>? ParseLayers(string? layers)
    {
        if (layers is null)
        {
            return null;
        }

        var set = new HashSet<PythonLayer> { PythonLayer.Domain };
        foreach (var name in layers.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            if (string.Equals(name, "infrastructure", StringComparison.OrdinalIgnoreCase))
            {
                set.Add(PythonLayer.Infrastructure);
            }
        }

        return set;
    }
}
