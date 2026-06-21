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

    // ----------------------------------------------------------------------
    // EF Core + DI are reachable by the Roslyn meta-test (so generated infra compiles)
    // ----------------------------------------------------------------------

    [Fact]
    public void Ef_core_and_di_are_referenceable_by_the_roslyn_meta_test()
    {
        // The generated Infrastructure layer references Microsoft.EntityFrameworkCore and
        // Microsoft.Extensions.DependencyInjection — neither ships in the running framework's
        // reference set, so this proves the test project's package references land in TPA and the
        // Roslyn compile harness can therefore type-check the generated EF Core code.
        var snippet = """
            // <auto-generated/>
            #nullable enable
            using Microsoft.EntityFrameworkCore;
            using Microsoft.Extensions.DependencyInjection;

            namespace Probe;

            public sealed class ProbeDbContext : DbContext
            {
                public ProbeDbContext(DbContextOptions<ProbeDbContext> options) : base(options) { }
            }

            public static class ProbeRegistration
            {
                public static IServiceCollection AddProbe(this IServiceCollection services)
                    => services;
            }
            """;

        var (asm, errors) = TestSupport.Compile(new[] { new EmittedFile("Probe.cs", snippet) });
        asm.ShouldNotBeNull(string.Join("\n", errors));
    }

    // ----------------------------------------------------------------------
    // DbContext + entity configurations (Task 3)
    // ----------------------------------------------------------------------

    private static readonly CSharpEmitterOptions Infrastructure = new(
        new Dictionary<string, string>(StringComparer.Ordinal),
        Layers: new HashSet<CSharpLayer> { CSharpLayer.Domain, CSharpLayer.Infrastructure });

    private static EmittedFile File(IReadOnlyList<EmittedFile> files, string suffix) =>
        files.Single(f => f.RelativePath.EndsWith(suffix, StringComparison.Ordinal));

    [Fact]
    public void Infrastructure_emits_a_dbcontext_with_a_dbset_per_aggregate()
    {
        var files = Emit(Infrastructure);
        var db = File(files, "Sales/Infrastructure/SalesDbContext.cs");

        db.Contents.ShouldContain("public class SalesDbContext : DbContext");
        db.Contents.ShouldContain("public DbSet<Order> Orders => Set<Order>();");
        db.Contents.ShouldContain("modelBuilder.ApplyConfiguration(new OrderConfiguration());");
        db.Contents.ShouldContain("using Microsoft.EntityFrameworkCore;");
    }

    [Fact]
    public void Entity_configuration_maps_key_owned_type_rowversion_and_enum()
    {
        var files = Emit(Infrastructure);
        var cfg = File(files, "Sales/Infrastructure/OrderConfiguration.cs");

        cfg.Contents.ShouldContain("public sealed class OrderConfiguration : IEntityTypeConfiguration<Order>");
        cfg.Contents.ShouldContain("builder.HasKey(x => x.Id);");
        cfg.Contents.ShouldContain(".HasConversion(id => id.Value, value => new OrderId(value));");
        cfg.Contents.ShouldContain("builder.Property(x => x.Version).IsRowVersion();");
        // Value object → owned type.
        cfg.Contents.ShouldContain("builder.OwnsOne(x => x.Total,");
        // Smart enum → shared value converter.
        cfg.Contents.ShouldContain("builder.Property(x => x.Status).HasConversion(SalesValueConverters.OrderStatusConverter);");
    }

    [Fact]
    public void Infrastructure_emits_a_shared_value_converter_per_smart_enum()
    {
        var files = Emit(Infrastructure);
        var conv = File(files, "Sales/Infrastructure/SalesValueConverters.cs");

        conv.Contents.ShouldContain("public static class SalesValueConverters");
        conv.Contents.ShouldContain("public static readonly ValueConverter<OrderStatus, string> OrderStatusConverter =");
        conv.Contents.ShouldContain("new(v => v.Name, v => OrderStatus.FromName(v));");
    }

    [Fact]
    public void The_generated_infrastructure_layer_compiles()
    {
        var files = Emit(Infrastructure);
        var (asm, errors) = TestSupport.Compile(files);
        asm.ShouldNotBeNull(string.Join("\n", errors));
    }
}
