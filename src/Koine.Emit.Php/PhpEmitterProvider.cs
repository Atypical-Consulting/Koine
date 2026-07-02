using Koine.Compiler.Emit;

namespace Koine.Compiler;

/// <summary>Provider for the PHP backend. Maps the neutral options to <see cref="PhpEmitterOptions"/>.</summary>
public sealed class PhpEmitterProvider : IEmitterProvider
{
    public string Target => "php";

    public string DisplayName => "PHP";

    public string FileExtension => ".php";

    public IEmitter Create(EmitterOptions options) => new PhpEmitter(ToPhpOptions(options));

    /// <summary>
    /// Maps the neutral <see cref="EmitterOptions"/> to <see cref="PhpEmitterOptions"/>. The shared
    /// namespace map is reused as the PHP namespace remap; keys are kept PascalCase (matching the
    /// context names the emitter computes). An empty bag maps to <see cref="PhpEmitterOptions.Empty"/>,
    /// so unconfigured targets emit byte-identical output.
    /// </summary>
    private static PhpEmitterOptions ToPhpOptions(EmitterOptions options)
    {
        // A timeout-only neutral bag must NOT collapse to Empty (issue #812): the configured value has to
        // reach the PHP `matches` lowering, mirroring the C# provider's guard (issue #794).
        if (options.NamespaceMap.Count == 0 && options.RegexMatchTimeoutMs is null)
        {
            return PhpEmitterOptions.Empty;
        }

        return new PhpEmitterOptions(options.NamespaceMap, options.RegexMatchTimeoutMs);
    }
}
