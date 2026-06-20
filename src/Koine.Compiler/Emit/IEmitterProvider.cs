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
    /// Creates the emitter for <see cref="Target"/>, mapping the neutral <paramref name="options"/>
    /// to the emitter's own option type. <see cref="EmitterOptions.Empty"/> must yield output
    /// byte-identical to a parameterless emitter.
    /// </summary>
    IEmitter Create(EmitterOptions options);
}
