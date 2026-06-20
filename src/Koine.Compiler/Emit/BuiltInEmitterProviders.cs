using Koine.Compiler.Emit.CSharp;
using Koine.Compiler.Emit.Docs;
using Koine.Compiler.Emit.Glossary;
using Koine.Compiler.Emit.Php;
using Koine.Compiler.Emit.Python;
using Koine.Compiler.Emit.TypeScript;

namespace Koine.Compiler.Emit;

/// <summary>
/// The built-in <see cref="IEmitterProvider"/> set, in display order. This is the single source of
/// truth for which targets ship with the compiler; the CLI and MCP registries both delegate here so
/// they can never drift (issue #69, Task 5). The neutral <see cref="EmitterOptions"/> → emitter-option
/// mapping that used to live in the CLI's private registry now lives in each provider's <c>Create</c>.
/// </summary>
internal static class BuiltInEmitterProviders
{
    /// <summary>The built-in providers, in the order targets are listed for help and errors.</summary>
    public static IReadOnlyList<IEmitterProvider> All { get; } = new IEmitterProvider[]
    {
        new CSharpEmitterProvider(),
        new TypeScriptEmitterProvider(),
        new PythonEmitterProvider(),
        new PhpEmitterProvider(),
        new GlossaryEmitterProvider(),
        new DocsEmitterProvider(),
    };
}

/// <summary>Provider for the C# backend. Maps the neutral options to <see cref="CSharpEmitterOptions"/>.</summary>
internal sealed class CSharpEmitterProvider : IEmitterProvider
{
    public string Target => "csharp";

    public IEmitter Create(EmitterOptions options) => new CSharpEmitter(ToCSharpOptions(options));

    /// <summary>
    /// Maps the neutral <see cref="EmitterOptions"/> to <see cref="CSharpEmitterOptions"/> (R16.1).
    /// An empty bag maps to <see cref="CSharpEmitterOptions.Empty"/>, so an unconfigured target emits
    /// byte-identical output. <c>instantMode = nodaTime</c> (case-insensitive) selects the NodaTime
    /// mode; anything else (incl. <c>dateTimeOffset</c> and absent) keeps the DateTimeOffset default.
    /// The <c>layout</c> key is accepted and currently a no-op (file-per-type is the only layout).
    /// </summary>
    private static CSharpEmitterOptions ToCSharpOptions(EmitterOptions options)
    {
        if (options.NamespaceMap.Count == 0 && options.InstantMode is null && !options.EmitSourceMaps)
        {
            return CSharpEmitterOptions.Empty;
        }

        var instant = string.Equals(options.InstantMode, "nodaTime", StringComparison.OrdinalIgnoreCase)
            ? CSharpInstantMode.NodaTime
            : CSharpInstantMode.DateTimeOffset;
        return new CSharpEmitterOptions(options.NamespaceMap, instant, options.EmitSourceMaps);
    }
}

/// <summary>Provider for the TypeScript backend. Maps the neutral options to <see cref="TsEmitterOptions"/>.</summary>
internal sealed class TypeScriptEmitterProvider : IEmitterProvider
{
    public string Target => "typescript";

    public IEmitter Create(EmitterOptions options) => new TypeScriptEmitter(ToTsOptions(options));

    /// <summary>
    /// Maps the neutral <see cref="EmitterOptions"/> to <see cref="TsEmitterOptions"/>. Only
    /// <see cref="EmitterOptions.EmitSourceMaps"/> is consumed today; with it off the result equals
    /// <see cref="TsEmitterOptions.Default"/>, so an unconfigured target emits byte-identical output.
    /// </summary>
    private static TsEmitterOptions ToTsOptions(EmitterOptions options)
    {
        if (!options.EmitSourceMaps)
        {
            return TsEmitterOptions.Default;
        }

        return new TsEmitterOptions { EmitSourceMaps = options.EmitSourceMaps };
    }
}

/// <summary>Provider for the Python backend. Maps the neutral options to <see cref="PythonEmitterOptions"/>.</summary>
internal sealed class PythonEmitterProvider : IEmitterProvider
{
    public string Target => "python";

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
        if (options.NamespaceMap.Count == 0)
        {
            return PythonEmitterOptions.Empty;
        }

        var packageMap = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var (context, package) in options.NamespaceMap)
        {
            packageMap[PythonNaming.ToSnakeCase(context)] = package;
        }

        return new PythonEmitterOptions(packageMap);
    }
}

/// <summary>Provider for the PHP backend. Maps the neutral options to <see cref="PhpEmitterOptions"/>.</summary>
internal sealed class PhpEmitterProvider : IEmitterProvider
{
    public string Target => "php";

    public IEmitter Create(EmitterOptions options) => new PhpEmitter(ToPhpOptions(options));

    /// <summary>
    /// Maps the neutral <see cref="EmitterOptions"/> to <see cref="PhpEmitterOptions"/>. The shared
    /// namespace map is reused as the PHP namespace remap; keys are kept PascalCase (matching the
    /// context names the emitter computes). An empty bag maps to <see cref="PhpEmitterOptions.Empty"/>,
    /// so unconfigured targets emit byte-identical output.
    /// </summary>
    private static PhpEmitterOptions ToPhpOptions(EmitterOptions options)
    {
        if (options.NamespaceMap.Count == 0)
        {
            return PhpEmitterOptions.Empty;
        }

        return new PhpEmitterOptions(options.NamespaceMap);
    }
}

/// <summary>Provider for the ubiquitous-language glossary emitter (no per-emit options).</summary>
internal sealed class GlossaryEmitterProvider : IEmitterProvider
{
    public string Target => "glossary";

    public IEmitter Create(EmitterOptions options) => new GlossaryEmitter();
}

/// <summary>Provider for the living-documentation emitter (no per-emit options).</summary>
internal sealed class DocsEmitterProvider : IEmitterProvider
{
    public string Target => "docs";

    public IEmitter Create(EmitterOptions options) => new DocsEmitter();
}
