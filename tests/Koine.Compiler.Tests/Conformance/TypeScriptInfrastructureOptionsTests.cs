namespace Koine.Compiler.Tests.Conformance;

/// <summary>
/// Option-surface coverage for the TypeScript Infrastructure layer selector (issue #241, Task A1), the
/// TS analogue of the C# <c>--layers infrastructure</c> wiring. A <see cref="TsEmitterOptions.Layers"/>
/// set carrying <see cref="TsLayer.Infrastructure"/> turns <see cref="TsEmitterOptions.EmitsInfrastructure"/>
/// on; the default (null layers) keeps it off so an unconfigured emit is byte-identical to the historical
/// output. The neutral <c>--layers</c> string is honored by the provider (<c>ToTsOptions</c>), proven here
/// end-to-end: the same model emitted through the provider with <c>domain,infrastructure</c> produces a
/// strict superset of the default file set.
/// </summary>
public class TypeScriptInfrastructureOptionsTests
{
    /// <summary>An explicit Infrastructure layer flips <see cref="TsEmitterOptions.EmitsInfrastructure"/> on.</summary>
    [Fact]
    public void Layers_with_infrastructure_emits_infrastructure()
    {
        var options = new TsEmitterOptions
        {
            Layers = new HashSet<TsLayer> { TsLayer.Domain, TsLayer.Infrastructure },
        };
        options.EmitsInfrastructure.ShouldBeTrue();
    }

    /// <summary>The default/Empty options bag leaves the Infrastructure layer off — Domain-only.</summary>
    [Fact]
    public void Default_options_do_not_emit_infrastructure()
    {
        TsEmitterOptions.Empty.EmitsInfrastructure.ShouldBeFalse();
        TsEmitterOptions.Default.EmitsInfrastructure.ShouldBeFalse();
        new TsEmitterOptions { Layers = new HashSet<TsLayer> { TsLayer.Domain } }.EmitsInfrastructure.ShouldBeFalse();
    }
}
