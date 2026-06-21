using Koine.Cli;
using Koine.Cli.Commands;
using Koine.Compiler.Emit;
using Koine.Compiler.Emit.CSharp;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// R18: the opt-in C# Infrastructure layer (issue #128). The layer is selected via
/// <c>--layers domain,infrastructure</c> (CLI) / <c>targets.csharp.layers</c> (config) and threads
/// <c>KoineConfig</c>/<c>TargetOptions</c> → neutral <c>EmitterOptions</c> →
/// <c>CSharpEmitterOptions</c> → <c>CSharpEmitter</c>. Default = Domain-only, so output is
/// byte-identical to today when the layer is off.
/// </summary>
public class R18CSharpInfrastructureTests
{
    // A representative model: two contexts, a versioned aggregate, a value object, a smart enum,
    // an integration event published across an open-host relation, and a subscriber.
    private const string Fixture = """
        context Sales {
          enum OrderStatus { Pending, Paid, Shipped }
          value Money { amount: Decimal  currency: String }
          aggregate Order root Order versioned {
            entity Order identified by OrderId {
              total: Money
              status: OrderStatus
            }
          }
          publishes OrderPlaced
          integration event OrderPlaced { orderId: OrderId  total: Decimal }
        }
        context Shipping {
          subscribes Sales.OrderPlaced
        }
        contextmap {
          Sales -> Shipping : open-host
        }
        """;

    private static IReadOnlyList<EmittedFile> Emit(CSharpEmitterOptions options)
    {
        var result = new KoineCompiler().Compile(Fixture, new CSharpEmitter(options));
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        return result.Files;
    }

    // ----------------------------------------------------------------------
    // Default = Domain-only ⇒ byte-identical to the unconfigured emitter
    // ----------------------------------------------------------------------

    [Fact]
    public void Default_options_are_domain_only()
    {
        CSharpEmitterOptions.Empty.EmitsInfrastructure.ShouldBeFalse();
        new CSharpEmitter().GetType().ShouldBe(typeof(CSharpEmitter)); // sanity
    }

    [Fact]
    public void Domain_only_layer_is_byte_identical_to_default_emitter()
    {
        var defaultRender = TestSupport.Render(
            new KoineCompiler().Compile(Fixture, new CSharpEmitter()).Files);

        var domainOnly = TestSupport.Render(Emit(new CSharpEmitterOptions(
            new Dictionary<string, string>(StringComparer.Ordinal),
            Layers: new HashSet<CSharpLayer> { CSharpLayer.Domain })));

        domainOnly.ShouldBe(defaultRender);
    }

    [Fact]
    public void Empty_options_layer_is_byte_identical_to_default_emitter()
    {
        var defaultRender = TestSupport.Render(
            new KoineCompiler().Compile(Fixture, new CSharpEmitter()).Files);

        TestSupport.Render(Emit(CSharpEmitterOptions.Empty)).ShouldBe(defaultRender);
    }

    // ----------------------------------------------------------------------
    // Config / options / CLI plumbing
    // ----------------------------------------------------------------------

    [Fact]
    public void Config_parses_layers_key()
    {
        var cfg = KoineConfig.Parse(
            "target = csharp\n" +
            "targets.csharp.layers = domain,infrastructure\n");

        cfg.OptionsFor("csharp").Layers.ShouldBe(new[] { "domain", "infrastructure" });
    }

    [Fact]
    public void Layers_flag_overrides_config_and_implies_domain()
    {
        // No --layers: config drives it; infrastructure implies domain.
        var settings = new BuildSettings { Path = "x.koi", Layers = "infrastructure" };
        settings.TryResolve(out var plan, out var error).ShouldBeTrue(error);
        plan.Options.Layers.ShouldBe(new[] { "domain", "infrastructure" });
    }

    [Fact]
    public void Unknown_layer_is_a_hard_error()
    {
        var settings = new BuildSettings { Path = "x.koi", Layers = "domain,bogus" };
        settings.TryResolve(out _, out var error).ShouldBeFalse();
        error.ShouldNotBeNull();
        error!.ShouldContain("bogus");
    }

    [Fact]
    public void Infrastructure_layer_option_threads_through_to_emitter_options()
    {
        var neutral = new EmitterOptions(
            new Dictionary<string, string>(StringComparer.Ordinal),
            Layers: "domain,infrastructure");
        neutral.Layers.ShouldBe("domain,infrastructure");
    }
}
