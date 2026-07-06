using Koine.Cli;
using Koine.Cli.Commands;
using Koine.Compiler.Emit;
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

    /// <summary>A minimal fixture with a DERIVED read-model field, to exercise the Mapperly per-field
    /// mapping helper (the main <see cref="Fixture"/> read model is all-direct).</summary>
    internal const string DerivedReadModelFixture = """
        context Sales {
          enum OrderStatus { Draft, Placed, Shipped }

          aggregate Order root Order {
            repository { operations: getById, add, update }

            entity Order identified by OrderId {
              customer: CustomerId
              status:   OrderStatus = Draft

              create open(customer: CustomerId) {}
            }
          }

          readmodel OrderCard from Order {
            id
            isPlaced: Bool = status == Placed
          }
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

    // ------------------------------------------------------------------
    // Issue #630 — a typo'd --app-mapping value must hard-error like an
    // unknown --layers name, not silently fall back to plain in the emitter.
    // ------------------------------------------------------------------

    [Fact]
    public void Unknown_app_mapping_is_a_hard_error()
    {
        var settings = new BuildSettings { Path = "x.koi", Layers = "application", AppMapping = "mapperley" };
        settings.TryResolve(out _, out var error).ShouldBeFalse();
        error.ShouldNotBeNull();
        error.ShouldContain("mapperley");
    }

    [Fact]
    public void Known_app_mapping_values_resolve_true_case_insensitively()
    {
        // The two modes the emitter understands, in any case, still resolve.
        new BuildSettings { Path = "x.koi", AppMapping = "mapperly" }
            .TryResolve(out _, out var e1).ShouldBeTrue(e1);
        new BuildSettings { Path = "x.koi", AppMapping = "Plain" }
            .TryResolve(out _, out var e2).ShouldBeTrue(e2);
        new BuildSettings { Path = "x.koi", AppMapping = "MapperLy" }
            .TryResolve(out _, out var e3).ShouldBeTrue(e3);
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

    // ------------------------------------------------------------------
    // W1 (make the Application layer adoptable) — --app-handler-result
    // void|aggregate: what a command handler returns. void (default) is
    // byte-identical to today; aggregate makes a void command's handler
    // return the loaded, mutated aggregate root (no re-load at the caller).
    // ------------------------------------------------------------------

    [Fact]
    public void Config_parses_application_handler_result()
    {
        var opts = KoineConfig
            .Parse("targets.csharp.application.handlerResult = aggregate\n")
            .OptionsFor("csharp");
        opts.ApplicationHandlerResult.ShouldBe("aggregate");
    }

    [Fact]
    public void App_handler_result_flag_implies_the_application_layer()
    {
        var settings = new BuildSettings { Path = "x.koi", AppHandlerResult = "aggregate" };
        settings.TryResolve(out var plan, out var error).ShouldBeTrue(error);
        plan.Options.Layers.ShouldBe(new[] { "domain", "application" });
        plan.Options.ApplicationHandlerResult.ShouldBe("aggregate");
    }

    [Fact]
    public void Unknown_app_handler_result_is_a_hard_error()
    {
        var settings = new BuildSettings { Path = "x.koi", Layers = "application", AppHandlerResult = "entity" };
        settings.TryResolve(out _, out var error).ShouldBeFalse();
        error.ShouldNotBeNull();
        error.ShouldContain("entity");
    }

    [Fact]
    public void Known_app_handler_result_values_resolve_true_case_insensitively()
    {
        new BuildSettings { Path = "x.koi", AppHandlerResult = "void" }
            .TryResolve(out _, out var e1).ShouldBeTrue(e1);
        new BuildSettings { Path = "x.koi", AppHandlerResult = "Aggregate" }
            .TryResolve(out _, out var e2).ShouldBeTrue(e2);
    }

    [Fact]
    public void Handler_result_default_void_is_byte_identical_to_app_on()
    {
        // The new option's default value must not perturb the Application-layer output.
        var explicitVoid = Emit(AppOn with { HandlerResult = CSharpHandlerResult.Void });
        TestSupport.Render(explicitVoid).ShouldBe(TestSupport.Render(Emit(AppOn)));
    }

    [Fact]
    public void Handler_result_aggregate_returns_the_mutated_aggregate_from_a_void_command()
    {
        var files = Emit(AppOn with { HandlerResult = CSharpHandlerResult.Aggregate });

        // The void `place` command now returns the loaded, mutated Order — and still compiles, since
        // Emit asserts a clean Roslyn compile of the whole emitted model.
        var handler = File(files, "OrderPlaceHandler.cs").Contents;
        handler.ShouldContain("Task<Order>");
        handler.ShouldContain("return aggregate;");
        handler.ShouldNotContain("return result;");
    }

    // ------------------------------------------------------------------
    // W1 — --app-not-found throw|nullable: how a handler treats a missing
    // aggregate. throw (default) is byte-identical to today; nullable
    // returns null on a miss (the caller maps it to a 404).
    // ------------------------------------------------------------------

    [Fact]
    public void Config_parses_application_not_found()
    {
        var opts = KoineConfig
            .Parse("targets.csharp.application.notFound = nullable\n")
            .OptionsFor("csharp");
        opts.ApplicationNotFound.ShouldBe("nullable");
    }

    [Fact]
    public void App_not_found_flag_implies_the_application_layer()
    {
        var settings = new BuildSettings { Path = "x.koi", AppNotFound = "nullable" };
        settings.TryResolve(out var plan, out var error).ShouldBeTrue(error);
        plan.Options.Layers.ShouldBe(new[] { "domain", "application" });
        plan.Options.ApplicationNotFound.ShouldBe("nullable");
    }

    [Fact]
    public void Unknown_app_not_found_is_a_hard_error()
    {
        var settings = new BuildSettings { Path = "x.koi", Layers = "application", AppNotFound = "maybe" };
        settings.TryResolve(out _, out var error).ShouldBeFalse();
        error.ShouldNotBeNull();
        error.ShouldContain("maybe");
    }

    [Fact]
    public void Known_app_not_found_values_resolve_true_case_insensitively()
    {
        new BuildSettings { Path = "x.koi", AppNotFound = "throw" }
            .TryResolve(out _, out var e1).ShouldBeTrue(e1);
        new BuildSettings { Path = "x.koi", AppNotFound = "Nullable" }
            .TryResolve(out _, out var e2).ShouldBeTrue(e2);
    }

    [Fact]
    public void Not_found_default_throw_is_byte_identical_to_app_on()
    {
        var explicitThrow = Emit(AppOn with { NotFound = CSharpNotFound.Throw });
        TestSupport.Render(explicitThrow).ShouldBe(TestSupport.Render(Emit(AppOn)));
    }

    [Fact]
    public void Not_found_nullable_returns_null_from_a_command_handler_on_a_miss()
    {
        var files = Emit(AppOn with { NotFound = CSharpNotFound.Nullable });

        // The void `place` command's handler now returns the (nullable) aggregate and yields null on a
        // miss instead of throwing. The whole model still compiles (Emit asserts a Roslyn compile).
        var handler = File(files, "OrderPlaceHandler.cs").Contents;
        handler.ShouldContain("Task<Order?>");
        handler.ShouldContain("if (aggregate is null)");
        handler.ShouldContain("return null;");
        handler.ShouldContain("return aggregate;");
        handler.ShouldNotContain("throw new InvalidOperationException");
    }

    [Fact]
    public void Not_found_nullable_makes_a_by_id_query_handler_return_null_on_a_miss()
    {
        var files = Emit(AppOn with { NotFound = CSharpNotFound.Nullable });

        // OrderById is a by-identity query — it now returns OrderSummary? and yields null on a miss.
        var handler = File(files, "OrderByIdHandler.cs").Contents;
        handler.ShouldContain("Task<OrderSummary?>");
        handler.ShouldContain("if (aggregate is null)");
        handler.ShouldContain("return null;");
        handler.ShouldNotContain("throw new InvalidOperationException");
    }

    // ------------------------------------------------------------------
    // W4 — --app-mapping mapperly: emit a Riok.Mapperly source-generated
    // projection instead of the hand-rolled To<RM>() mapper. plain (the
    // default) is unchanged / byte-identical.
    // ------------------------------------------------------------------

    [Fact]
    public void Mapping_plain_read_model_uses_the_hand_rolled_projection()
    {
        var rm = File(Emit(AppOn), "OrderSummary.cs").Contents;
        rm.ShouldContain("public static class OrderSummaryProjection");
        rm.ShouldContain("=> new OrderSummary(");
        rm.ShouldNotContain("[Mapper]");
    }

    [Fact]
    public void Mapping_mapperly_emits_a_mapper_static_partial_extension()
    {
        var rm = File(Emit(AppOn with { Mapping = CSharpMappingMode.Mapperly }), "OrderSummary.cs").Contents;
        rm.ShouldContain("using Riok.Mapperly.Abstractions;");
        rm.ShouldContain("[Mapper]");
        rm.ShouldContain("public static partial class OrderSummaryProjection");
        rm.ShouldContain("public static partial OrderSummary ToOrderSummary(this Order src);");
        // A pure-direct read model needs no per-field mapping helper, and no hand-rolled body.
        rm.ShouldNotContain("MapPropertyFromSource");
        rm.ShouldNotContain("=> new OrderSummary(");
    }

    [Fact]
    public void Mapping_mapperly_maps_a_derived_field_via_a_helper()
    {
        var files = Emit(AppOn with { Mapping = CSharpMappingMode.Mapperly }, DerivedReadModelFixture);
        var rm = File(files, "OrderCard.cs").Contents;
        rm.ShouldContain("[MapPropertyFromSource(nameof(OrderCard.IsPlaced), Use = nameof(MapIsPlaced))]");
        rm.ShouldContain("public static partial OrderCard ToOrderCard(this Order src);");
        rm.ShouldContain("private static bool MapIsPlaced(Order src)");
    }

    // ------------------------------------------------------------------
    // W2 — the opt-in `api` layer: ASP.NET Minimal-API endpoints binding
    // commands/factories (POST) and queries (GET) to the Application-layer
    // handlers. Implies `application`; off by default.
    // ------------------------------------------------------------------

    /// <summary>The Application + endpoint layers on (the api layer implies application).</summary>
    internal static CSharpEmitterOptions ApiOn =>
        CSharpEmitterOptions.Empty with
        {
            Layers = new HashSet<CSharpLayer> { CSharpLayer.Domain, CSharpLayer.Application, CSharpLayer.Api },
        };

    [Fact]
    public void Config_parses_the_api_layer()
    {
        var opts = KoineConfig.Parse("targets.csharp.layers = domain, application, api\n").OptionsFor("csharp");
        opts.Layers.ShouldBe(new[] { "domain", "application", "api" });
    }

    [Fact]
    public void Api_layer_implies_application()
    {
        var settings = new BuildSettings { Path = "x.koi", Layers = "api" };
        settings.TryResolve(out var plan, out var error).ShouldBeTrue(error);
        plan.Options.Layers.ShouldBe(new[] { "domain", "application", "api" });
    }

    [Fact]
    public void Unknown_layer_is_a_hard_error_listing_api()
    {
        var settings = new BuildSettings { Path = "x.koi", Layers = "bogus" };
        settings.TryResolve(out _, out var error).ShouldBeFalse();
        error.ShouldNotBeNull();
        error.ShouldContain("bogus");
        error.ShouldContain("api");
    }

    [Fact]
    public void Api_layer_off_adds_no_endpoint_file()
    {
        Emit(AppOn).ShouldNotContain(f => f.RelativePath.EndsWith("Endpoints.cs", StringComparison.Ordinal));
    }

    [Fact]
    public void Api_layer_maps_a_command_to_a_post_endpoint()
    {
        var endpoints = File(Emit(ApiOn), "SalesEndpoints.cs").Contents;
        endpoints.ShouldContain("using Microsoft.AspNetCore.Builder;");
        endpoints.ShouldContain("public static class SalesEndpoints");
        endpoints.ShouldContain("public static IEndpointRouteBuilder MapSalesEndpoints(this IEndpointRouteBuilder endpoints)");
        endpoints.ShouldContain("endpoints.MapPost(\"/order/place\", async (OrderPlaceRequest request, OrderPlaceHandler handler, CancellationToken ct) =>");
        endpoints.ShouldContain("await handler.HandleAsync(request, ct);");
        endpoints.ShouldContain("return Results.Ok();");
    }

    [Fact]
    public void Api_layer_maps_a_query_to_a_get_endpoint()
    {
        var endpoints = File(Emit(ApiOn), "SalesEndpoints.cs").Contents;
        endpoints.ShouldContain("endpoints.MapGet(\"/order-by-id\", async ([AsParameters] OrderById query, OrderByIdHandler handler, CancellationToken ct) =>");
    }

    [Fact]
    public void Api_layer_nullable_not_found_maps_a_missing_aggregate_to_404()
    {
        var endpoints = File(Emit(ApiOn with { NotFound = CSharpNotFound.Nullable }), "SalesEndpoints.cs").Contents;
        endpoints.ShouldContain("return result is null ? Results.NotFound() : Results.Ok(result);");
    }

    [Fact]
    public void Config_supplied_application_mediatr_upgrades_layers_without_a_layers_flag()
    {
        var configPath = System.IO.Path.Combine(
            System.IO.Path.GetTempPath(), $"koine-{System.Guid.NewGuid():N}.toml");
        System.IO.File.WriteAllText(configPath, "targets.csharp.application.mediatr = true\n");
        try
        {
            var settings = new BuildSettings { Path = "x.koi", Config = configPath };
            settings.TryResolve(out var plan, out var error).ShouldBeTrue(error);
            plan.Options.Layers.ShouldBe(new[] { "domain", "application" });
        }
        finally
        {
            System.IO.File.Delete(configPath);
        }
    }

    [Fact]
    public void Application_layer_value_implies_domain_and_maps_through_the_provider()
    {
        // The neutral provider mapping: `application` among the layers turns the C# Application
        // layer on; `domain`-only (or no layers) keeps the byte-identical domain output.
        var domainOnly = new EmitterRegistry(BuiltInEmitterProviders.All).TryCreate(
            "csharp", new EmitterOptions(new Dictionary<string, string>(), Layers: "domain"), out var d);
        domainOnly.ShouldBeTrue();

        var withApp = new EmitterRegistry(BuiltInEmitterProviders.All).TryCreate(
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

    // ------------------------------------------------------------------
    // W1 (#1041) — --app-not-found result: return a generated Result<T>
    // instead of throwing/nulling on a missing aggregate. Task 1 plumbs the
    // option and emits the Result<T> runtime type; Task 2 wires the returns.
    // ------------------------------------------------------------------

    [Fact]
    public void Config_parses_application_not_found_result()
    {
        var opts = KoineConfig
            .Parse("targets.csharp.application.notFound = result\n")
            .OptionsFor("csharp");
        opts.ApplicationNotFound.ShouldBe("result");
    }

    [Fact]
    public void App_not_found_result_flag_implies_the_application_layer()
    {
        var settings = new BuildSettings { Path = "x.koi", AppNotFound = "result" };
        settings.TryResolve(out var plan, out var error).ShouldBeTrue(error);
        plan.Options.Layers.ShouldBe(new[] { "domain", "application" });
        plan.Options.ApplicationNotFound.ShouldBe("result");
    }

    [Fact]
    public void Known_app_not_found_result_resolves_true_case_insensitively()
    {
        new BuildSettings { Path = "x.koi", AppNotFound = "result" }
            .TryResolve(out _, out var e1).ShouldBeTrue(e1);
        new BuildSettings { Path = "x.koi", AppNotFound = "Result" }
            .TryResolve(out _, out var e2).ShouldBeTrue(e2);
    }

    [Fact]
    public void Result_type_is_emitted_and_compiles_under_the_result_policy()
    {
        // Emit asserts a clean Roslyn compile of the whole model, so this also proves Result<T> compiles.
        var files = Emit(AppOn with { NotFound = CSharpNotFound.Result });
        var result = files.Single(f => f.RelativePath == "Koine/Runtime/Result.cs");
        result.Contents.ShouldContain("public readonly struct Result<T>");
        result.Contents.ShouldContain("public static Result<T> Ok(T value)");
        result.Contents.ShouldContain("public static Result<T> NotFound()");
        result.Contents.ShouldContain("public bool IsSuccess");
    }

    [Fact]
    public void Result_type_is_absent_under_throw_and_nullable_policies()
    {
        Emit(AppOn).ShouldNotContain(f => f.RelativePath == "Koine/Runtime/Result.cs");
        Emit(AppOn with { NotFound = CSharpNotFound.Nullable })
            .ShouldNotContain(f => f.RelativePath == "Koine/Runtime/Result.cs");
    }
}
