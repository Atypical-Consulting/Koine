using Koine.Compiler.Emit.AsyncApi;
using Koine.Compiler.Emit.CSharp;
using Koine.Compiler.Emit.Docs;
using Koine.Compiler.Emit.Glossary;
using Koine.Compiler.Emit.OpenApi;
using Koine.Compiler.Emit.Php;
using Koine.Compiler.Emit.Python;
using Koine.Compiler.Emit.Rust;
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
        new RustEmitterProvider(),
        new GlossaryEmitterProvider(),
        new DocsEmitterProvider(),
        new AsyncApiEmitterProvider(),
        new OpenApiEmitterProvider(),
    };
}

/// <summary>Provider for the C# backend. Maps the neutral options to <see cref="CSharpEmitterOptions"/>.</summary>
internal sealed class CSharpEmitterProvider : IEmitterProvider
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
    /// </summary>
    private static CSharpEmitterOptions ToCSharpOptions(EmitterOptions options)
    {
        if (options.NamespaceMap.Count == 0 && options.InstantMode is null && !options.EmitSourceMaps
            && !options.ReferenceOnly && options.Layers is null
            && !options.ApplicationMediatr && options.ApplicationMapping is null)
        {
            return CSharpEmitterOptions.Empty;
        }

        var instant = string.Equals(options.InstantMode, "nodaTime", StringComparison.OrdinalIgnoreCase)
            ? CSharpInstantMode.NodaTime
            : CSharpInstantMode.DateTimeOffset;
        var mapping = string.Equals(options.ApplicationMapping, "mapperly", StringComparison.OrdinalIgnoreCase)
            ? CSharpMappingMode.Mapperly
            : CSharpMappingMode.Plain;
        return new CSharpEmitterOptions(
            options.NamespaceMap, instant, options.EmitSourceMaps, options.ReferenceOnly,
            ParseLayers(options.Layers), options.ApplicationMediatr, mapping);
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

/// <summary>Provider for the TypeScript backend. Maps the neutral options to <see cref="TsEmitterOptions"/>.</summary>
internal sealed class TypeScriptEmitterProvider : IEmitterProvider
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
        if (options.NamespaceMap.Count == 0 && !options.EmitSourceMaps && !options.ReferenceOnly
            && options.Layers is null)
        {
            return TsEmitterOptions.Empty;
        }

        return new TsEmitterOptions
        {
            EmitSourceMaps = options.EmitSourceMaps,
            ModuleMap = options.NamespaceMap,
            ReferenceOnly = options.ReferenceOnly,
            Layers = ParseLayers(options.Layers),
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

/// <summary>Provider for the Python backend. Maps the neutral options to <see cref="PythonEmitterOptions"/>.</summary>
internal sealed class PythonEmitterProvider : IEmitterProvider
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
        if (options.NamespaceMap.Count == 0)
        {
            return PhpEmitterOptions.Empty;
        }

        return new PhpEmitterOptions(options.NamespaceMap);
    }
}

/// <summary>Provider for the Rust backend. Maps the neutral options to <see cref="RustEmitterOptions"/>.</summary>
internal sealed class RustEmitterProvider : IEmitterProvider
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

/// <summary>Provider for the ubiquitous-language glossary emitter (no per-emit options).</summary>
internal sealed class GlossaryEmitterProvider : IEmitterProvider
{
    public string Target => "glossary";

    /// <summary>The glossary is documentation, not a code-emit target the IDE offers (issue #282).</summary>
    public bool IsEmitTarget => false;

    public IEmitter Create(EmitterOptions options) => new GlossaryEmitter();
}

/// <summary>Provider for the living-documentation emitter (no per-emit options).</summary>
internal sealed class DocsEmitterProvider : IEmitterProvider
{
    public string Target => "docs";

    /// <summary>Living docs is documentation, not a code-emit target the IDE offers (issue #282).</summary>
    public bool IsEmitTarget => false;

    public IEmitter Create(EmitterOptions options) => new DocsEmitter();
}

/// <summary>Provider for the AsyncAPI 3.0 emitter (no per-emit options).</summary>
internal sealed class AsyncApiEmitterProvider : IEmitterProvider
{
    public string Target => "asyncapi";

    public string DisplayName => "AsyncAPI";

    public string FileExtension => ".yaml";

    public IEmitter Create(EmitterOptions options) => new AsyncApiEmitter();
}

/// <summary>Provider for the OpenAPI 3.1 spec emitter (issue #126; no per-emit options).</summary>
internal sealed class OpenApiEmitterProvider : IEmitterProvider
{
    public string Target => "openapi";

    public string DisplayName => "OpenAPI";

    public string FileExtension => ".yaml";

    public IEmitter Create(EmitterOptions options) => new OpenApiEmitter();
}
