namespace Koine.Compiler.Tests.Conformance;

/// <summary>
/// Option-surface coverage for the Python Infrastructure layer selector (issue #241, Task B1), the
/// Python analogue of the C# <c>--layers infrastructure</c> wiring. A <see cref="PythonEmitterOptions.Layers"/>
/// set carrying <see cref="PythonLayer.Infrastructure"/> turns
/// <see cref="PythonEmitterOptions.EmitsInfrastructure"/> on; the default (null layers) keeps it off so an
/// unconfigured emit is byte-identical to the historical output.
/// </summary>
public class PythonInfrastructureOptionsTests
{
    /// <summary>An explicit Infrastructure layer flips <see cref="PythonEmitterOptions.EmitsInfrastructure"/> on.</summary>
    [Fact]
    public void Layers_with_infrastructure_emits_infrastructure()
    {
        var options = PythonEmitterOptions.Empty with
        {
            Layers = new HashSet<PythonLayer> { PythonLayer.Domain, PythonLayer.Infrastructure },
        };
        options.EmitsInfrastructure.ShouldBeTrue();
    }

    /// <summary>The default/Empty options bag leaves the Infrastructure layer off — Domain-only.</summary>
    [Fact]
    public void Default_options_do_not_emit_infrastructure()
    {
        PythonEmitterOptions.Empty.EmitsInfrastructure.ShouldBeFalse();
        (PythonEmitterOptions.Empty with { Layers = new HashSet<PythonLayer> { PythonLayer.Domain } })
            .EmitsInfrastructure.ShouldBeFalse();
    }
}
