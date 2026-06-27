using Koine.Cli;
using Koine.Cli.Commands;
using Koine.Compiler.Emit;
using Koine.Compiler.Emit.CSharp;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Issue #129 — the opt-in C# <b>Application layer</b>: concrete use-case/command/factory handlers
/// implementing the emitted application contracts, FluentValidation validators derived from
/// invariants, query handlers, an <c>Add&lt;Context&gt;Application</c> DI extension, and an opt-in
/// MediatR sub-mode. Selected via <c>--layers domain,application</c>; with the layer off the emitted
/// C# is byte-identical to today.
/// </summary>
public class R18CSharpApplicationTests
{
    /// <summary>
    /// A read/write fixture exercising the whole Application surface: a value object with an
    /// invariant, an aggregate whose root entity carries a command (precondition + transition +
    /// emit) and a factory (precondition over a value-object parameter + emit), a configured
    /// repository, a service with use cases, a read model, and single + list queries.
    /// </summary>
    internal const string Fixture = """
        context Sales {
          enum OrderStatus { Draft, Placed, Shipped }

          value Money {
            amount:   Decimal
            currency: String
            invariant amount >= 0   "amount cannot be negative"
          }

          aggregate Order root Order {
            repository {
              operations: getById, add, update
            }

            event OrderPlaced {
              orderId: OrderId
              total:   Money
            }

            entity Order identified by OrderId {
              customer: CustomerId
              total:    Money
              status:   OrderStatus = Draft

              invariant total.amount >= 0   "order total cannot be negative"

              states status {
                Draft  -> Placed, Shipped
                Placed -> Shipped
                Shipped
              }

              command place {
                requires status == Draft   "order must be a draft to place"
                status -> Placed
                emit OrderPlaced(orderId: id, total: total)
              }

              create open(customer: CustomerId, total: Money) {
                requires total.amount >= 0   "an order total cannot be negative"
                emit OrderPlaced(orderId: id, total: total)
              }
            }
          }

          service OrderService {
            usecase PlaceOrder(order: OrderId)
            usecase OpenOrder(customer: CustomerId, total: Money): OrderId
          }

          readmodel OrderSummary from Order {
            id
            customer
            status
          }

          query OrderById(id: OrderId): OrderSummary
          query OrdersByStatus(status: OrderStatus): List<OrderSummary>
        }
        """;

    /// <summary>Emits the fixture with the given C# options and asserts a clean compile of the model.</summary>
    internal static IReadOnlyList<EmittedFile> Emit(CSharpEmitterOptions options, string source = Fixture)
    {
        var result = new KoineCompiler().Compile(
            new[] { new SourceFile("sales.koi", source) },
            new CSharpEmitter(options));
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        return result.Files;
    }

    /// <summary>The Application layer turned on, plain mode (the default sub-options).</summary>
    internal static CSharpEmitterOptions AppOn =>
        CSharpEmitterOptions.Empty with
        {
            Layers = new HashSet<CSharpLayer> { CSharpLayer.Domain, CSharpLayer.Application },
        };

    internal static EmittedFile File(IReadOnlyList<EmittedFile> files, string suffix) =>
        files.Single(f => f.RelativePath.EndsWith(suffix, StringComparison.Ordinal));

    // ------------------------------------------------------------------
    // Task 1 — layer value + sub-option plumbing, default off.
    // ------------------------------------------------------------------

    [Fact]
    public void Application_layer_off_is_byte_identical_to_the_default_emitter()
    {
        var off = Emit(CSharpEmitterOptions.Empty);
        var unconfigured = new KoineCompiler().Compile(
            new[] { new SourceFile("sales.koi", Fixture) },
            new CSharpEmitter()).Files;

        TestSupport.Render(off).ShouldBe(TestSupport.Render(unconfigured));
    }

    [Fact]
    public void Config_parses_layers_and_application_sub_options()
    {
        var cfg = KoineConfig.Parse(
            "targets.csharp.layers = domain, application\n" +
            "targets.csharp.application.mediatr = true\n" +
            "targets.csharp.application.mapping = mapperly\n");

        var opts = cfg.OptionsFor("csharp");
        opts.Layers.ShouldBe(new[] { "domain", "application" });
        opts.ApplicationMediatr.ShouldBeTrue();
        opts.ApplicationMapping.ShouldBe("mapperly");
    }

    [Fact]
    public void Unconfigured_target_has_no_layers_and_plain_defaults()
    {
        var opts = KoineConfig.Parse("target = csharp\n").OptionsFor("csharp");
        opts.Layers.ShouldBeNull();
        opts.ApplicationMediatr.ShouldBeFalse();
        opts.ApplicationMapping.ShouldBeNull();
    }

    [Fact]
    public void ParseLayers_normalizes_and_drops_blanks()
    {
        KoineConfig.ParseLayers("Domain , Application ,").ShouldBe(new[] { "domain", "application" });
        KoineConfig.ParseLayers("  ").ShouldBeNull();
        KoineConfig.ParseLayers(null).ShouldBeNull();
    }

    // ------------------------------------------------------------------
    // Issue #618 — the Application sub-options (--app-mediatr/--app-mapping)
    // imply the Application layer, mirroring how application/infrastructure
    // already imply domain. Without this they were silently inert unless
    // --layers application was passed too.
    // ------------------------------------------------------------------

    [Fact]
    public void App_mediatr_flag_implies_the_application_layer()
    {
        var settings = new BuildSettings { Path = "x.koi", AppMediatr = true };
        settings.TryResolve(out var plan, out var error).ShouldBeTrue(error);
        plan.Options.Layers.ShouldBe(new[] { "domain", "application" });
        plan.Options.ApplicationMediatr.ShouldBeTrue();
    }

    [Fact]
    public void App_mapping_flag_implies_the_application_layer()
    {
        var settings = new BuildSettings { Path = "x.koi", AppMapping = "mapperly" };
        settings.TryResolve(out var plan, out var error).ShouldBeTrue(error);
        plan.Options.Layers.ShouldBe(new[] { "domain", "application" });
        plan.Options.ApplicationMapping.ShouldBe("mapperly");
    }

    [Fact]
    public void Explicit_app_mapping_plain_also_implies_the_application_layer()
    {
        // An explicitly-typed --app-mapping plain is intentional, so it implies the layer too.
        var settings = new BuildSettings { Path = "x.koi", AppMapping = "plain" };
        settings.TryResolve(out var plan, out var error).ShouldBeTrue(error);
        plan.Options.Layers.ShouldBe(new[] { "domain", "application" });
    }

    [Fact]
    public void Explicit_layers_domain_is_upgraded_to_include_application_for_app_flags()
    {
        // --layers domain --app-mediatr: the explicit domain selection must not block the implication.
        var settings = new BuildSettings { Path = "x.koi", Layers = "domain", AppMediatr = true };
        settings.TryResolve(out var plan, out var error).ShouldBeTrue(error);
        plan.Options.Layers.ShouldBe(new[] { "domain", "application" });
    }

    [Fact]
    public void Application_layer_already_present_is_not_duplicated_by_app_flags()
    {
        var settings = new BuildSettings { Path = "x.koi", Layers = "application", AppMediatr = true };
        settings.TryResolve(out var plan, out var error).ShouldBeTrue(error);
        plan.Options.Layers.ShouldBe(new[] { "domain", "application" });
    }

    [Fact]
    public void App_flags_preserve_a_requested_infrastructure_layer()
    {
        var settings = new BuildSettings { Path = "x.koi", Layers = "infrastructure", AppMediatr = true };
        settings.TryResolve(out var plan, out var error).ShouldBeTrue(error);
        plan.Options.Layers.ShouldBe(new[] { "domain", "application", "infrastructure" });
    }

    [Fact]
    public void No_app_flags_leaves_layers_null_domain_only()
    {
        // No-regression guarantee: absent app sub-options ⇒ Layers stays null (Domain-only).
        var settings = new BuildSettings { Path = "x.koi" };
        settings.TryResolve(out var plan, out var error).ShouldBeTrue(error);
        plan.Options.Layers.ShouldBeNull();
    }

    [Fact]
    public void Config_supplied_application_mediatr_upgrades_layers_without_a_layers_flag()
    {
        var settings = new BuildSettings
        {
            Path = "x.koi",
            Config = WriteConfig("targets.csharp.application.mediatr = true\n"),
        };
        settings.TryResolve(out var plan, out var error).ShouldBeTrue(error);
        plan.Options.Layers.ShouldBe(new[] { "domain", "application" });
    }

    private static string WriteConfig(string contents)
    {
        var path = System.IO.Path.Combine(
            System.IO.Path.GetTempPath(), $"koine-{System.Guid.NewGuid():N}.toml");
        System.IO.File.WriteAllText(path, contents);
        return path;
    }

    [Fact]
    public void Application_layer_value_implies_domain_and_maps_through_the_provider()
    {
        // The neutral provider mapping: `application` among the layers turns the C# Application
        // layer on; `domain`-only (or no layers) keeps the byte-identical domain output.
        var domainOnly = new EmitterRegistry().TryCreate(
            "csharp", new EmitterOptions(new Dictionary<string, string>(), Layers: "domain"), out var d);
        domainOnly.ShouldBeTrue();

        var withApp = new EmitterRegistry().TryCreate(
            "csharp", new EmitterOptions(new Dictionary<string, string>(), Layers: "domain,application"), out _);
        withApp.ShouldBeTrue();

        // Domain-only must match the unconfigured emitter byte-for-byte.
        var model = new[] { new SourceFile("sales.koi", Fixture) };
        var domainFiles = new KoineCompiler().Compile(model, d).Files;
        var baseline = new KoineCompiler().Compile(model, new CSharpEmitter()).Files;

        TestSupport.Render(domainFiles).ShouldBe(TestSupport.Render(baseline));
    }

    // ------------------------------------------------------------------
    // Task 2 — plain use-case/command/factory handlers + request records.
    // ------------------------------------------------------------------

    [Fact]
    public void Command_emits_a_request_record_and_a_handler_that_loads_invokes_and_saves()
    {
        var files = Emit(AppOn);

        var request = File(files, "Application/OrderPlaceRequest.cs");
        request.Contents.ShouldContain("public sealed record OrderPlaceRequest(OrderId Id);");

        var handler = File(files, "Application/OrderPlaceHandler.cs");
        handler.Contents.ShouldContain("public sealed class OrderPlaceHandler");
        handler.Contents.ShouldContain("private readonly IUnitOfWork _unitOfWork;");
        handler.Contents.ShouldContain("await _unitOfWork.Orders.GetByIdAsync(request.Id, ct)");
        handler.Contents.ShouldContain("aggregate.Place();");
        handler.Contents.ShouldContain("await _unitOfWork.SaveChangesAsync(ct);");
    }

    [Fact]
    public void Factory_emits_a_request_record_and_a_handler_that_creates_adds_and_saves()
    {
        var files = Emit(AppOn);

        File(files, "Application/OrderOpenRequest.cs").Contents
            .ShouldContain("public sealed record OrderOpenRequest(CustomerId Customer, Money Total);");

        var handler = File(files, "Application/OrderOpenHandler.cs");
        handler.Contents.ShouldContain("public async Task<Order> HandleAsync(OrderOpenRequest request, CancellationToken ct = default)");
        handler.Contents.ShouldContain("var aggregate = Order.Open(request.Customer, request.Total);");
        handler.Contents.ShouldContain("await _unitOfWork.Orders.AddAsync(aggregate, ct);");
        handler.Contents.ShouldContain("return aggregate;");
    }

    [Fact]
    public void Application_layer_output_roslyn_compiles()
    {
        var files = Emit(AppOn);
        var (assembly, errors) = TestSupport.Compile(files);
        assembly.ShouldNotBeNull(string.Join("\n", errors));
    }

    [Fact]
    public void Application_layer_off_emits_no_application_files()
    {
        var off = Emit(CSharpEmitterOptions.Empty);
        off.ShouldNotContain(f => f.RelativePath.Contains("/Application/", StringComparison.Ordinal));
    }

    // ------------------------------------------------------------------
    // Task 3 — FluentValidation validators derived from invariants.
    // ------------------------------------------------------------------

    [Fact]
    public void Validator_re_encodes_value_object_invariants_with_their_messages()
    {
        var files = Emit(AppOn);
        var validator = File(files, "Application/OrderOpenRequestValidator.cs");

        validator.Contents.ShouldContain("using FluentValidation;");
        validator.Contents.ShouldContain("public sealed class OrderOpenRequestValidator : FluentValidation.AbstractValidator<OrderOpenRequest>");
        // The Money parameter's invariant (amount >= 0) is re-encoded, message intact.
        validator.Contents.ShouldContain("RuleFor(x => x.Total).Must(p => p.Amount >= 0).WithMessage(\"amount cannot be negative\");");
        // The factory's parameter-only `requires` is a whole-request rule.
        validator.Contents.ShouldContain("RuleFor(x => x).Must(x => x.Total.Amount >= 0).WithMessage(\"an order total cannot be negative\");");
    }

    [Fact]
    public void Validator_skips_requires_that_reference_entity_state()
    {
        // `place` requires `status == Draft` — entity state, not a parameter — so no rule is derivable.
        var files = Emit(AppOn);
        var validator = File(files, "Application/OrderPlaceRequestValidator.cs");
        validator.Contents.ShouldContain("public sealed class OrderPlaceRequestValidator");
        validator.Contents.ShouldNotContain("Draft");
        validator.Contents.ShouldNotContain("RuleFor");
    }

    // ------------------------------------------------------------------
    // Task 4 — query handlers + read-model projection.
    // ------------------------------------------------------------------

    [Fact]
    public void Single_query_keyed_by_identity_loads_and_projects_via_the_read_model_mapper()
    {
        var files = Emit(AppOn);
        var handler = File(files, "Application/OrderByIdHandler.cs");

        handler.Contents.ShouldContain("public sealed class OrderByIdHandler : Koine.Runtime.IQueryHandler<OrderById, OrderSummary>");
        handler.Contents.ShouldContain("await _unitOfWork.Orders.GetByIdAsync(query.Id, ct)");
        handler.Contents.ShouldContain("return aggregate.ToOrderSummary();");
    }

    [Fact]
    public void List_query_without_a_derivable_store_query_throws_not_implemented()
    {
        var files = Emit(AppOn);
        var handler = File(files, "Application/OrdersByStatusHandler.cs");

        handler.Contents.ShouldContain("Koine.Runtime.IQueryHandler<OrdersByStatus, IReadOnlyList<OrderSummary>>");
        handler.Contents.ShouldContain("throw new System.NotImplementedException(");
    }

    // ------------------------------------------------------------------
    // Task 5 — MediatR opt-in sub-mode.
    // ------------------------------------------------------------------

    [Fact]
    public void Mediatr_mode_emits_requests_handlers_and_pipeline_behaviors_that_compile()
    {
        var files = Emit(AppOn with { ApplicationMediatr = true });

        File(files, "Application/OrderOpenRequest.cs").Contents
            .ShouldContain("public sealed record OrderOpenRequest(CustomerId Customer, Money Total) : MediatR.IRequest<Order>;");
        var handler = File(files, "Application/OrderOpenHandler.cs");
        handler.Contents.ShouldContain(": MediatR.IRequestHandler<OrderOpenRequest, Order>");
        handler.Contents.ShouldContain("public async Task<Order> Handle(OrderOpenRequest request, CancellationToken cancellationToken)");
        // The transaction behavior commits; the handler must not save itself.
        handler.Contents.ShouldNotContain("SaveChangesAsync");

        File(files, "Application/ValidationBehavior.cs").Contents
            .ShouldContain("MediatR.IPipelineBehavior<TRequest, TResponse>");
        File(files, "Application/TransactionBehavior.cs").Contents
            .ShouldContain("await _unitOfWork.SaveChangesAsync(cancellationToken);");

        var (assembly, errors) = TestSupport.Compile(files);
        assembly.ShouldNotBeNull(string.Join("\n", errors));
    }

    [Fact]
    public void Mediatr_mode_off_emits_no_mediatr_symbol()
    {
        var files = Emit(AppOn);
        foreach (var f in files.Where(f => f.RelativePath.Contains("/Application/", StringComparison.Ordinal)))
        {
            f.Contents.ShouldNotContain("MediatR");
        }
    }

    // ------------------------------------------------------------------
    // Task 6 — AddXApplication DI extension.
    // ------------------------------------------------------------------

    [Fact]
    public void Di_extension_registers_handlers_validators_query_handlers_and_services()
    {
        var files = Emit(AppOn);
        var di = File(files, "Application/SalesApplicationServiceCollectionExtensions.cs");

        di.Contents.ShouldContain("using Microsoft.Extensions.DependencyInjection;");
        di.Contents.ShouldContain("public static Microsoft.Extensions.DependencyInjection.IServiceCollection AddSalesApplication(");
        di.Contents.ShouldContain("services.AddTransient<OrderPlaceHandler>();");
        di.Contents.ShouldContain("services.AddTransient<OrderOpenHandler>();");
        di.Contents.ShouldContain("services.AddTransient<FluentValidation.IValidator<OrderOpenRequest>, OrderOpenRequestValidator>();");
        di.Contents.ShouldContain("services.AddTransient<Koine.Runtime.IQueryHandler<OrderById, OrderSummary>, OrderByIdHandler>();");
        di.Contents.ShouldContain("services.AddTransient<IOrderService, OrderServiceApplication>();");
        di.Contents.ShouldContain("return services;");
    }

    [Fact]
    public void Di_extension_in_mediatr_mode_registers_handlers_by_interface_and_pipeline_behaviors()
    {
        var files = Emit(AppOn with { ApplicationMediatr = true });
        var di = File(files, "Application/SalesApplicationServiceCollectionExtensions.cs");

        di.Contents.ShouldContain("services.AddTransient<MediatR.IRequestHandler<OrderOpenRequest, Order>, OrderOpenHandler>();");
        di.Contents.ShouldContain("services.AddTransient(typeof(MediatR.IPipelineBehavior<,>), typeof(ValidationBehavior<,>));");
        di.Contents.ShouldContain("services.AddTransient(typeof(MediatR.IPipelineBehavior<,>), typeof(TransactionBehavior<,>));");
    }

    // ------------------------------------------------------------------
    // Task 7 — edge cases.
    // ------------------------------------------------------------------

    [Fact]
    public void Service_use_case_implementation_throws_until_bound()
    {
        var files = Emit(AppOn);
        var impl = File(files, "Application/OrderServiceApplication.cs");

        impl.Contents.ShouldContain("public sealed class OrderServiceApplication : IOrderService");
        impl.Contents.ShouldContain("public Task PlaceOrder(OrderId order, CancellationToken ct = default)");
        impl.Contents.ShouldContain("public Task<OrderId> OpenOrder(CustomerId customer, Money total, CancellationToken ct = default)");
        impl.Contents.ShouldContain("throw new System.NotImplementedException(");
    }

    [Fact]
    public void Context_without_aggregates_or_services_emits_no_application_files()
    {
        const string src = "context C {\n  value V { n: Int }\n}\n";
        var files = Emit(AppOn, src);
        files.ShouldNotContain(f => f.RelativePath.Contains("/Application/", StringComparison.Ordinal));
    }

    [Fact]
    public void Command_parameter_named_id_does_not_collide_with_the_identity_property()
    {
        // A command param named `id` (allowed for commands) must not produce a duplicate `Id`
        // record property; the synthetic identity property takes a non-colliding name instead.
        const string src = """
            context Sales {
              aggregate Order root Order {
                entity Order identified by OrderId {
                  name: String
                  command annotate(id: String) {
                    requires id != ""   "id must not be blank"
                  }
                }
              }
            }
            """;
        var files = Emit(AppOn, src);
        var request = File(files, "Application/OrderAnnotateRequest.cs");
        request.Contents.ShouldContain("OrderId AggregateId");
        request.Contents.ShouldContain("string Id");
        File(files, "Application/OrderAnnotateHandler.cs").Contents
            .ShouldContain("GetByIdAsync(request.AggregateId,");
        // The whole model (domain + application) still Roslyn-compiles.
        var (assembly, errors) = TestSupport.Compile(files);
        assembly.ShouldNotBeNull(string.Join("\n", errors));
    }

    [Fact]
    public void Repository_without_getById_skips_command_handlers()
    {
        const string src = """
            context Sales {
              enum OrderStatus { Draft, Placed }
              aggregate Order root Order {
                repository { operations: add }
                entity Order identified by OrderId {
                  status: OrderStatus = Draft
                  states status {
                    Draft -> Placed
                    Placed
                  }
                  command place {
                    status -> Placed
                  }
                }
              }
            }
            """;
        var files = Emit(AppOn, src);
        files.ShouldNotContain(f => f.RelativePath.EndsWith("OrderPlaceHandler.cs", StringComparison.Ordinal));
    }
}
