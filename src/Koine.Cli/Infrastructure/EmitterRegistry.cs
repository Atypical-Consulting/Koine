using Koine.Compiler.Emit;
using Koine.Compiler.Emit.CSharp;
using Koine.Compiler.Emit.Docs;
using Koine.Compiler.Emit.Glossary;
using Koine.Compiler.Emit.TypeScript;

namespace Koine.Cli.Infrastructure;

/// <summary>
/// Maps a <c>--target</c> name to the emitter that produces it. The single place that knows
/// about concrete <see cref="IEmitter"/> implementations, so adding a target is one entry
/// here (and the validation/help that reads <see cref="SupportedTargets"/> follows).
/// </summary>
internal static class EmitterRegistry
{
    private static readonly IReadOnlyDictionary<string, Func<TargetOptions, IEmitter>> Factories =
        new Dictionary<string, Func<TargetOptions, IEmitter>>(StringComparer.OrdinalIgnoreCase)
        {
            ["csharp"] = opts => new CSharpEmitter(ToCSharpOptions(opts)),
            ["typescript"] = _ => new TypeScriptEmitter(),
            ["glossary"] = _ => new GlossaryEmitter(),
            ["docs"] = _ => new DocsEmitter(),
        };

    /// <summary>The supported target names, in display order for help and error messages.</summary>
    public static IReadOnlyList<string> SupportedTargets { get; } =
        new[] { "csharp", "typescript", "glossary", "docs" };

    /// <summary>A comma-separated list of <see cref="SupportedTargets"/>, for messages.</summary>
    public static string SupportedList => string.Join(", ", SupportedTargets);

    public static bool IsSupported(string target) => Factories.ContainsKey(target);

    /// <summary>Creates the emitter for <paramref name="target"/>, or returns <c>false</c> if unknown.</summary>
    public static bool TryCreate(string target, TargetOptions options, out IEmitter emitter)
    {
        if (Factories.TryGetValue(target, out var factory))
        {
            emitter = factory(options);
            return true;
        }

        emitter = null!;
        return false;
    }

    /// <summary>
    /// Maps the CLI's parsed per-target <see cref="TargetOptions"/> to the C# emitter's
    /// <see cref="CSharpEmitterOptions"/> (R16.1). An empty options bag maps to
    /// <see cref="CSharpEmitterOptions.Empty"/>, so an unconfigured target emits byte-identical
    /// output. <c>instantMode = nodaTime</c> (case-insensitive) selects the NodaTime mode;
    /// anything else (incl. <c>dateTimeOffset</c> and absent) keeps the DateTimeOffset default.
    /// The <c>layout</c> key is accepted and currently a no-op (file-per-type is the only layout).
    /// </summary>
    private static CSharpEmitterOptions ToCSharpOptions(TargetOptions options)
    {
        if (options.NamespaceMap.Count == 0 && options.InstantMode is null)
        {
            return CSharpEmitterOptions.Empty;
        }

        var instant = string.Equals(options.InstantMode, "nodaTime", StringComparison.OrdinalIgnoreCase)
            ? CSharpInstantMode.NodaTime
            : CSharpInstantMode.DateTimeOffset;
        return new CSharpEmitterOptions(options.NamespaceMap, instant);
    }
}
