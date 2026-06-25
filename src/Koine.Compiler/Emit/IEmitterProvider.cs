namespace Koine.Compiler.Emit;

/// <summary>
/// A provider for one emit target — the public plugin contract that opens the emitter pipeline as a
/// platform (issue #69, Task 5). It names a <see cref="Target"/> and builds an <see cref="IEmitter"/>
/// from host-neutral <see cref="EmitterOptions"/>. The built-in C#/TypeScript/Python/PHP/glossary/docs
/// emitters are themselves registered as providers; external assemblies may contribute their own.
///
/// <para>Any public, concrete type with a public parameterless constructor that implements this
/// interface is discovered by the <see cref="EmitterLoader"/> from an assembly named in
/// <c>koine.config</c>'s <c>emitters</c> key, exactly mirroring how
/// <see cref="Koine.Compiler.Semantics.AnalyzerLoader"/> discovers analyzers.</para>
/// </summary>
public interface IEmitterProvider
{
    /// <summary>The target identifier this provider serves, e.g. <c>"csharp"</c> (case-insensitive).</summary>
    string Target { get; }

    /// <summary>
    /// A human-facing label for this target, e.g. <c>"C#"</c> (issue #282). Surfaced via
    /// <see cref="EmitterRegistry.SupportedTargetInfos"/> so editors can render a friendly name.
    /// Defaults to <see cref="Target"/> when a provider declares nothing.
    /// </summary>
    string DisplayName => Target;

    /// <summary>
    /// The file extension this target emits, e.g. <c>".cs"</c> (issue #282). Surfaced via
    /// <see cref="EmitterRegistry.SupportedTargetInfos"/>. Defaults to <c>".txt"</c>.
    /// </summary>
    string FileExtension => ".txt";

    /// <summary>
    /// Whether this provider is a code-emit target the IDE should offer in its target list (issue
    /// #282). Defaults to <c>true</c>; the built-in <c>glossary</c>/<c>docs</c> providers override it
    /// to <c>false</c> — they are documentation generators, not languages a user picks to preview, so
    /// they stay resolvable via <see cref="EmitterRegistry.SupportedTargets"/> but are excluded from
    /// <see cref="EmitterRegistry.SupportedTargetInfos"/>.
    /// </summary>
    bool IsEmitTarget => true;

    /// <summary>
    /// Creates the emitter for <see cref="Target"/>, mapping the neutral <paramref name="options"/>
    /// to the emitter's own option type. <see cref="EmitterOptions.Empty"/> must yield output
    /// byte-identical to a parameterless emitter.
    /// </summary>
    IEmitter Create(EmitterOptions options);
}
