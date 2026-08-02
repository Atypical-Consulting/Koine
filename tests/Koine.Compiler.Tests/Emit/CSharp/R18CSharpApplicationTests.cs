using System.Net;
using System.Net.Http;
using System.Net.Http.Json;
using System.Text.Json;
using Koine.Cli;
using Koine.Cli.Commands;
using Koine.Compiler.Ast;
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
    // W1 — --app-dispatch-events: dispatch each recorded domain event AFTER
    // the transaction commits, then clear the aggregate's list. Off by
    // default (byte-identical); the seam a SignalR broadcast rides (#1039).
    // ------------------------------------------------------------------

    [Fact]
    public void Dispatch_events_off_emits_no_dispatcher_contract()
    {
        var files = Emit(AppOn);
        files.ShouldNotContain(f => f.RelativePath.EndsWith("IDomainEventDispatcher.cs", StringComparison.Ordinal));
    }

    [Fact]
    public void Dispatch_events_default_off_is_byte_identical_to_app_on()
    {
        // The new option's default value must not perturb the Application-layer output.
        var explicitOff = Emit(AppOn with { DispatchEvents = false });
        TestSupport.Render(explicitOff).ShouldBe(TestSupport.Render(Emit(AppOn)));
    }

    [Fact]
    public void Dispatch_events_emits_the_domain_event_dispatcher_contract()
    {
        var contract = File(Emit(AppOn with { DispatchEvents = true }), "IDomainEventDispatcher.cs").Contents;

        // A contract only — the consumer supplies the implementation, exactly as with IUnitOfWork.
        contract.ShouldContain("public interface IDomainEventDispatcher");
        contract.ShouldContain("Task DispatchAsync(IDomainEvent domainEvent, CancellationToken ct = default);");
        contract.ShouldContain("namespace Koine.Runtime");
    }

    /// <summary>The index of <paramref name="needle"/> in <paramref name="haystack"/>, asserted present.</summary>
    private static int IndexOfOrFail(string haystack, string needle)
    {
        var at = haystack.IndexOf(needle, StringComparison.Ordinal);
        at.ShouldBeGreaterThanOrEqualTo(0, $"expected to find: {needle}");
        return at;
    }

    [Fact]
    public void Dispatch_events_injects_the_dispatcher_into_a_command_handler()
    {
        var handler = File(Emit(AppOn with { DispatchEvents = true }), "OrderPlaceHandler.cs").Contents;

        handler.ShouldContain("private readonly IDomainEventDispatcher _dispatcher;");
        handler.ShouldContain("public OrderPlaceHandler(IUnitOfWork unitOfWork, IDomainEventDispatcher dispatcher)");
        handler.ShouldContain("_dispatcher = dispatcher;");
    }

    [Fact]
    public void Dispatch_events_loops_after_the_commit_then_clears_in_a_command_handler()
    {
        var handler = File(Emit(AppOn with { DispatchEvents = true }), "OrderPlaceHandler.cs").Contents;

        handler.ShouldContain("foreach (var domainEvent in aggregate.DomainEvents)");
        handler.ShouldContain("await _dispatcher.DispatchAsync(domainEvent, ct);");
        handler.ShouldContain("aggregate.ClearDomainEvents();");

        // Post-commit is the whole point: an event dispatched BEFORE the commit could announce a
        // transaction that then rolled back. And the list is cleared only after the loop completes,
        // so a mid-dispatch throw leaves the events visible for a retry rather than dropping them.
        var commit = IndexOfOrFail(handler, "await _unitOfWork.SaveChangesAsync(ct);");
        var loop = IndexOfOrFail(handler, "foreach (var domainEvent in aggregate.DomainEvents)");
        var clear = IndexOfOrFail(handler, "aggregate.ClearDomainEvents();");
        commit.ShouldBeLessThan(loop);
        loop.ShouldBeLessThan(clear);
    }

    [Fact]
    public void Dispatch_events_loops_after_the_commit_in_a_factory_handler()
    {
        var handler = File(Emit(AppOn with { DispatchEvents = true }), "OrderOpenHandler.cs").Contents;

        handler.ShouldContain("public OrderOpenHandler(IUnitOfWork unitOfWork, IDomainEventDispatcher dispatcher)");
        var commit = IndexOfOrFail(handler, "await _unitOfWork.SaveChangesAsync(ct);");
        var loop = IndexOfOrFail(handler, "foreach (var domainEvent in aggregate.DomainEvents)");
        var clear = IndexOfOrFail(handler, "aggregate.ClearDomainEvents();");
        var ret = IndexOfOrFail(handler, "return aggregate;");
        commit.ShouldBeLessThan(loop);
        loop.ShouldBeLessThan(clear);
        clear.ShouldBeLessThan(ret);
    }

    [Fact]
    public void Dispatch_events_emits_no_loop_for_a_root_that_records_no_events()
    {
        // DerivedReadModelFixture's Order has neither an emitting command nor an emitting factory, so
        // it carries no DomainEvents member — emitting the loop there would not compile.
        var files = Emit(AppOn with { DispatchEvents = true }, DerivedReadModelFixture);

        var handler = File(files, "OrderOpenHandler.cs").Contents;
        handler.ShouldNotContain("DomainEvents");
        handler.ShouldNotContain("_dispatcher");
        files.ShouldNotContain(f => f.RelativePath.EndsWith("IDomainEventDispatcher.cs", StringComparison.Ordinal));
    }

    [Fact]
    public void Dispatch_events_sits_between_the_commit_and_the_return_under_read_model_results()
    {
        // The handler returns a projection, but must still dispatch and clear off the AGGREGATE —
        // so the loop belongs after the commit and before the `return`, in every result branch.
        var handler = File(
            Emit(AppOn with { DispatchEvents = true, HandlerResult = CSharpHandlerResult.ReadModel }),
            "OrderPlaceHandler.cs").Contents;

        var commit = IndexOfOrFail(handler, "await _unitOfWork.SaveChangesAsync(ct);");
        var clear = IndexOfOrFail(handler, "aggregate.ClearDomainEvents();");
        var ret = IndexOfOrFail(handler, "return aggregate.ToOrderSummary();");
        commit.ShouldBeLessThan(clear);
        clear.ShouldBeLessThan(ret);
    }


    /// <summary>
    /// The dispatch machinery must be gated on whether the context actually <i>records</i> events, not
    /// on the option alone. The runtime contracts (<c>IDomainEventDispatcher</c>,
    /// <c>IDomainEventAccumulator</c>) are emitted only for a model that has events — so a model with
    /// none, built with the option on, must not emit a <c>TransactionBehavior</c> or a DI registration
    /// referencing types that were never generated. Caught during review of #1721.
    /// </summary>
    [Fact]
    public void Dispatch_events_on_a_model_that_records_no_events_still_compiles()
    {
        var files = Emit(MediatrDispatchOn, DerivedReadModelFixture);

        var (assembly, errors) = TestSupport.Compile(files);
        assembly.ShouldNotBeNull(string.Join("\n", errors));

        var behavior = File(files, "TransactionBehavior.cs").Contents;
        behavior.ShouldContain("public TransactionBehavior(IUnitOfWork unitOfWork)");
        behavior.ShouldNotContain("IDomainEventAccumulator");

        var di = File(files, "SalesApplicationServiceCollectionExtensions.cs").Contents;
        di.ShouldNotContain("IDomainEventAccumulator");
    }

    /// <summary>The Application layer on in MediatR mode with post-commit dispatch requested.</summary>
    internal static CSharpEmitterOptions MediatrDispatchOn =>
        AppOn with { ApplicationMediatr = true, DispatchEvents = true };

    [Fact]
    public void Dispatch_events_mediatr_emits_the_accumulator_and_its_scoped_default()
    {
        var files = Emit(MediatrDispatchOn);

        var contract = File(files, "IDomainEventAccumulator.cs").Contents;
        contract.ShouldContain("public interface IDomainEventAccumulator");
        contract.ShouldContain("void AddRange(IReadOnlyList<IDomainEvent> domainEvents);");
        contract.ShouldContain("IReadOnlyList<IDomainEvent> Drain();");

        // A leading slash keeps the suffix match off IDomainEventAccumulator.cs.
        var impl = File(files, "/DomainEventAccumulator.cs").Contents;
        impl.ShouldContain("public sealed class DomainEventAccumulator : IDomainEventAccumulator");
        impl.ShouldContain("var drained = _domainEvents.ToArray();");
    }

    [Fact]
    public void Dispatch_events_mediatr_accumulates_in_the_handler_without_dispatching()
    {
        // In MediatR mode the commit is deferred to TransactionBehavior, so the handler has no
        // post-commit moment — it hands the events off and lets the behavior dispatch them.
        var handler = File(Emit(MediatrDispatchOn), "OrderPlaceHandler.cs").Contents;

        handler.ShouldContain("public OrderPlaceHandler(IUnitOfWork unitOfWork, IDomainEventAccumulator accumulator)");
        handler.ShouldContain("_accumulator.AddRange(aggregate.DomainEvents);");
        handler.ShouldContain("aggregate.ClearDomainEvents();");
        handler.ShouldNotContain("DispatchAsync");
    }

    [Fact]
    public void Dispatch_events_mediatr_drains_and_dispatches_after_the_commit()
    {
        var behavior = File(Emit(MediatrDispatchOn), "TransactionBehavior.cs").Contents;

        behavior.ShouldContain("then dispatches the domain events the handlers recorded");
        behavior.ShouldContain("public TransactionBehavior(IUnitOfWork unitOfWork, IDomainEventAccumulator accumulator, IDomainEventDispatcher dispatcher)");
        var commit = IndexOfOrFail(behavior, "await _unitOfWork.SaveChangesAsync(cancellationToken);");
        var drain = IndexOfOrFail(behavior, "foreach (var domainEvent in _accumulator.Drain())");
        var dispatch = IndexOfOrFail(behavior, "await _dispatcher.DispatchAsync(domainEvent, cancellationToken);");
        var ret = IndexOfOrFail(behavior, "return response;");
        commit.ShouldBeLessThan(drain);
        drain.ShouldBeLessThan(dispatch);
        dispatch.ShouldBeLessThan(ret);
    }

    [Fact]
    public void Dispatch_events_off_leaves_the_mediatr_transaction_behavior_byte_identical()
    {
        var off = File(Emit(AppOn with { ApplicationMediatr = true }), "TransactionBehavior.cs").Contents;
        off.ShouldContain("public TransactionBehavior(IUnitOfWork unitOfWork)");
        off.ShouldNotContain("IDomainEventAccumulator");
        off.ShouldNotContain("DispatchAsync");
    }

    [Fact]
    public void Dispatch_events_registers_the_accumulator_but_never_the_dispatcher()
    {
        var di = File(Emit(MediatrDispatchOn), "SalesApplicationServiceCollectionExtensions.cs").Contents;

        // Scoped, so one accumulator spans a request and its events cannot leak into another's.
        di.ShouldContain("services.AddScoped<IDomainEventAccumulator, DomainEventAccumulator>();");

        // The dispatcher is a CONTRACT Koine emits but never implements — registering a binding for
        // it would either fail at resolve time or silently shadow the consumer's own registration.
        di.ShouldNotContain("IDomainEventDispatcher,");
        di.ShouldNotContain("AddScoped<IDomainEventDispatcher");
        di.ShouldNotContain("AddTransient<IDomainEventDispatcher");

        // …and the generated code says so itself, so a consumer reading only the output knows.
        di.ShouldContain("Supply your own IDomainEventDispatcher registration");
    }

    [Fact]
    public void Dispatch_events_registers_no_accumulator_in_plain_mode()
    {
        // Plain handlers dispatch inline, so there is nothing to accumulate.
        var di = File(Emit(AppOn with { DispatchEvents = true }), "SalesApplicationServiceCollectionExtensions.cs").Contents;
        di.ShouldNotContain("IDomainEventAccumulator");
    }

    /// <summary>A recording <c>IDomainEventDispatcher</c> plus a unit of work that logs its commit, so a
    /// test can assert the emitted handler dispatches <b>after</b> committing and not before.</summary>
    private const string RecordingDispatcherSource = """
        namespace Sales;

        public sealed class RecordingDispatcher : Koine.Runtime.IDomainEventDispatcher
        {
            public static readonly System.Collections.Generic.List<string> Log = new();

            public System.Threading.Tasks.Task DispatchAsync(Koine.Runtime.IDomainEvent domainEvent, System.Threading.CancellationToken ct = default)
            {
                Log.Add("dispatch:" + domainEvent.GetType().Name);
                return System.Threading.Tasks.Task.CompletedTask;
            }
        }

        public sealed class RecordingUnitOfWork : IUnitOfWork
        {
            public RecordingUnitOfWork(IOrderRepository orders) => Orders = orders;

            public IOrderRepository Orders { get; }

            public System.Threading.Tasks.Task<int> SaveChangesAsync(System.Threading.CancellationToken ct = default)
            {
                RecordingDispatcher.Log.Add("commit");
                return System.Threading.Tasks.Task.FromResult(0);
            }
        }
        """;

    [Fact]
    public void Dispatch_events_plain_output_compiles()
    {
        var files = Emit(AppOn with { DispatchEvents = true }, CommandsOnlyFixture)
            .Append(new EmittedFile("FakeOrderRepository.cs", FakeOrderRepositorySource.Source))
            .Append(new EmittedFile("RecordingDispatcher.cs", RecordingDispatcherSource))
            .ToList();

        var (assembly, errors) = TestSupport.Compile(files);
        assembly.ShouldNotBeNull(string.Join("\n", errors));
    }

    [Fact]
    public void Dispatch_events_mediatr_output_compiles()
    {
        var files = Emit(MediatrDispatchOn, CommandsOnlyFixture)
            .Append(new EmittedFile("FakeOrderRepository.cs", FakeOrderRepositorySource.Source))
            .Append(new EmittedFile("RecordingDispatcher.cs", RecordingDispatcherSource))
            .ToList();

        var (assembly, errors) = TestSupport.Compile(files);
        assembly.ShouldNotBeNull(string.Join("\n", errors));
    }

    /// <summary>Boots the emitted api layer with post-commit dispatch on, wiring the recording
    /// dispatcher through the emitted DI extension so a real HTTP call exercises the whole path.</summary>
    private const string DispatchingApiHostDriver = """
        using Microsoft.AspNetCore.Builder;
        using Microsoft.AspNetCore.Hosting;
        using Microsoft.AspNetCore.TestHost;
        using Microsoft.Extensions.DependencyInjection;
        using Microsoft.Extensions.Hosting;

        namespace Sales;

        public static class ApiHostDriver
        {
            public static WebApplication Build()
            {
                var builder = WebApplication.CreateBuilder();
                builder.WebHost.UseTestServer();
                builder.Services.AddSalesApplication();

                var repository = new FakeOrderRepository();
                builder.Services.AddSingleton<IUnitOfWork>(new RecordingUnitOfWork(repository));

                // The consumer supplies the dispatcher implementation — Koine emits only the contract.
                builder.Services.AddSingleton<Koine.Runtime.IDomainEventDispatcher, RecordingDispatcher>();

                var app = builder.Build();
                app.MapSalesEndpoints();

                // Surfaces the recorded ordering so the test can read it over the same HTTP hop.
                app.MapGet("/__log", () => RecordingDispatcher.Log);

                app.Start();
                return app;
            }
        }
        """;

    [Fact]
    public async Task Dispatch_events_dispatches_a_real_event_after_the_commit_over_http()
    {
        // Each RunApi compiles a fresh assembly, so RecordingDispatcher.Log starts empty.
        var files = Emit(ApiOn with { DispatchEvents = true }, CommandsOnlyFixture)
            .Append(new EmittedFile("FakeOrderRepository.cs", FakeOrderRepositorySource.Source))
            .Append(new EmittedFile("RecordingDispatcher.cs", RecordingDispatcherSource));

        using var harness = TestSupport.RunApi(files, DispatchingApiHostDriver);

        var response = await harness.Client.PostAsJsonAsync(
            "/order/open",
            new { customer = new { value = Guid.NewGuid() }, total = new { amount = 42.50m, currency = "USD" } },
            TestContext.Current.CancellationToken);

        response.StatusCode.ShouldBe(HttpStatusCode.OK);

        // The factory's `emit OrderPlaced` reached a real dispatcher — and only after the commit.
        var log = await harness.Client.GetFromJsonAsync<string[]>(
            "/__log", TestContext.Current.CancellationToken);
        log.ShouldBe(new[] { "commit", "dispatch:OrderPlaced" });
    }

    [Fact]
    public void Config_parses_application_dispatch_events()
    {
        var opts = KoineConfig
            .Parse("targets.csharp.application.dispatchEvents = true\n")
            .OptionsFor("csharp");
        opts.ApplicationDispatchEvents.ShouldBeTrue();
    }

    [Fact]
    public void App_dispatch_events_flag_resolves_onto_the_plan()
    {
        var settings = new BuildSettings { Path = "x.koi", AppDispatchEvents = true };
        settings.TryResolve(out var plan, out var error).ShouldBeTrue(error);
        plan.Options.ApplicationDispatchEvents.ShouldBeTrue();
    }

    [Fact]
    public void App_dispatch_events_flag_implies_the_application_layer()
    {
        // Issue #618's rule: a sub-option can never be a silent no-op because the layers defaulted
        // to domain-only.
        var settings = new BuildSettings { Path = "x.koi", AppDispatchEvents = true };
        settings.TryResolve(out var plan, out var error).ShouldBeTrue(error);
        plan.Options.Layers.ShouldBe(new[] { "domain", "application" });
    }

    [Fact]
    public void Config_supplied_dispatch_events_applies_and_upgrades_layers_without_a_flag()
    {
        // Bool sub-options are flag-OR-config (the --app-mediatr precedent), not flag-overrides-config:
        // there is no "explicitly false" to express, so a config `true` stands on its own.
        var configPath = System.IO.Path.Combine(
            System.IO.Path.GetTempPath(), $"koine-{System.Guid.NewGuid():N}.toml");
        System.IO.File.WriteAllText(configPath, "targets.csharp.application.dispatchEvents = true\n");
        try
        {
            var settings = new BuildSettings { Path = "x.koi", Config = configPath };
            settings.TryResolve(out var plan, out var error).ShouldBeTrue(error);
            plan.Options.ApplicationDispatchEvents.ShouldBeTrue();
            plan.Options.Layers.ShouldBe(new[] { "domain", "application" });
        }
        finally
        {
            System.IO.File.Delete(configPath);
        }
    }

    [Fact]
    public void App_dispatch_events_absent_still_maps_to_the_empty_options_bag()
    {
        var settings = new BuildSettings { Path = "x.koi" };
        settings.TryResolve(out var plan, out var error).ShouldBeTrue(error);
        plan.Options.ApplicationDispatchEvents.ShouldBeFalse();
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

    /// <summary>The plain (non-acronym) counterpart to
    /// <see cref="Api_layer_factory_endpoint_kebabs_acronym_boundaries_like_openapi"/>: <see cref="Fixture"/>'s
    /// <c>Order</c> aggregate declares a repository <c>add</c> operation and an <c>open</c> factory, so
    /// <c>WriteFactoryEndpoint</c> must map it to <c>POST /order/open</c> — this route text was never
    /// asserted anywhere before this test, only the sibling <c>place</c> command's route was.</summary>
    [Fact]
    public void Api_layer_maps_a_factory_to_a_post_endpoint()
    {
        var endpoints = File(Emit(ApiOn), "SalesEndpoints.cs").Contents;
        endpoints.ShouldContain("endpoints.MapPost(\"/order/open\", async (OrderOpenRequest request, OrderOpenHandler handler, CancellationToken ct) =>");
    }

    /// <summary>An acronym-bearing entity name (four consecutive capitals), to prove the api layer's
    /// route-building agrees with the openapi emitter's acronym-aware kebab-casing (#1042 / W2.0).</summary>
    internal const string XmlImportFixture = """
        context Imports {
          aggregate XMLImport root XMLImport {
            repository {
              operations: getById
            }

            entity XMLImport identified by XMLImportId {
              command retry {
              }
            }
          }
        }
        """;

    /// <summary>
    /// The naive per-uppercase <c>Kebab</c> that used to live on <c>CSharpEmitter.Api.cs</c> dashed
    /// before EVERY uppercase after position 0, so <c>XMLImport</c> produced <c>/x-m-l-import/retry</c>.
    /// The shared, acronym-aware <see cref="RouteDerivation.Kebab"/> (Task 1) only dashes before an
    /// uppercase that follows a lowercase/digit or ends an acronym run, so it agrees with the openapi
    /// emitter and produces <c>/xml-import/retry</c>.
    /// </summary>
    [Fact]
    public void Api_layer_kebabs_acronym_boundaries_like_openapi()
    {
        var endpoints = File(Emit(ApiOn, XmlImportFixture), "ImportsEndpoints.cs").Contents;
        endpoints.ShouldContain("endpoints.MapPost(\"/xml-import/retry\", ");
    }

    /// <summary>An acronym-bearing entity name with a <c>create</c> factory rather than a <c>command</c>
    /// (#1238): <c>WriteFactoryEndpoint</c> builds its route via <see cref="RouteDerivation.ForFactory"/>
    /// (#1747), which kebabs through the same acronym-aware <see cref="RouteDerivation.Kebab"/> the
    /// command/query endpoint writers use — this is the one call site #1042 left unasserted for an
    /// acronym-bearing name.</summary>
    internal const string XmlImportFactoryFixture = """
        context Imports {
          aggregate XMLImport root XMLImport {
            repository {
              operations: add
            }

            entity XMLImport identified by XMLImportId {
              create open() {
              }
            }
          }
        }
        """;

    [Fact]
    public void Api_layer_factory_endpoint_kebabs_acronym_boundaries_like_openapi()
    {
        var endpoints = File(Emit(ApiOn, XmlImportFactoryFixture), "ImportsEndpoints.cs").Contents;
        endpoints.ShouldContain("endpoints.MapPost(\"/xml-import/open\", ");
    }

    /// <summary>A multi-word factory name, asserted against <see cref="RouteDerivation.ForFactory"/>
    /// directly rather than a literal (#1747): the emitted path can never silently drift from the
    /// shared derivation, since <c>WriteFactoryEndpoint</c> now reads <see cref="RouteInfo.Route"/>
    /// off it instead of hand-concatenating <see cref="RouteDerivation.Kebab"/> calls.</summary>
    internal const string MultiWordFactoryFixture = """
        context Sales {
          aggregate Order root Order {
            repository {
              operations: add, getById
            }

            entity Order identified by OrderId {
              create openDraft() {
              }
            }
          }
        }
        """;

    [Fact]
    public void Api_layer_factory_endpoint_route_matches_RouteDerivation_ForFactory()
    {
        var endpoints = File(Emit(ApiOn, MultiWordFactoryFixture), "SalesEndpoints.cs").Contents;

        var entity = new EntityDecl("Order", "OrderId", [], [], [], [], []);
        var factory = new FactoryDecl("OpenDraft", Parameters: [], Body: []);
        var expectedRoute = RouteDerivation.ForFactory(entity, factory).Route;

        expectedRoute.ShouldBe("/order/open-draft");
        endpoints.ShouldContain(
            $"endpoints.MapPost(\"{expectedRoute}\", async (OrderOpenDraftRequest request, OrderOpenDraftHandler handler, CancellationToken ct) =>");
    }

    [Fact]
    public void Api_layer_nullable_not_found_maps_a_missing_aggregate_to_404()
    {
        var endpoints = File(Emit(ApiOn with { NotFound = CSharpNotFound.Nullable }), "SalesEndpoints.cs").Contents;
        endpoints.ShouldContain("return result is null ? Results.NotFound() : Results.Ok(result);");
    }

    /// <summary>
    /// Unlike every other emitted C# target, the api (endpoint) layer was never Roslyn-compiled — only
    /// string-asserted — because the test process didn't reference <c>Microsoft.AspNetCore.App</c>, so
    /// <see cref="TestSupport.Compile"/> couldn't resolve <c>IEndpointRouteBuilder</c>/<c>Results</c>/
    /// <c>MapPost</c>. A `FrameworkReference` in the test csproj closes that gap (issue #1148).
    /// </summary>
    [Fact]
    public void Api_layer_output_compiles()
    {
        var (assembly, errors) = TestSupport.Compile(Emit(ApiOn));
        assembly.ShouldNotBeNull(string.Join("\n", errors));
    }

    /// <summary>Compile-checks the nullable not-found policy's endpoint mapping (issue #1148).</summary>
    [Fact]
    public void Api_layer_nullable_not_found_output_compiles()
    {
        var (assembly, errors) = TestSupport.Compile(Emit(ApiOn with { NotFound = CSharpNotFound.Nullable }));
        assembly.ShouldNotBeNull(string.Join("\n", errors));
    }

    // ------------------------------------------------------------------
    // Issue #1591 — runtime-verify the api layer's endpoints over real HTTP,
    // not just that they Roslyn-compile. Task 1: a fake IOrderRepository/
    // IUnitOfWork test double compiled alongside the emitted model, proving
    // its shape matches the generated repository interface before any HTTP
    // wiring exists.
    // ------------------------------------------------------------------

    [Fact]
    public void Fake_order_repository_satisfies_the_emitted_repository_interface_shape()
    {
        var files = Emit(ApiOn)
            .Append(new EmittedFile("FakeOrderRepository.cs", FakeOrderRepositorySource.Source))
            .ToList();
        var (assembly, errors) = TestSupport.Compile(files);
        assembly.ShouldNotBeNull(string.Join("\n", errors));

        var repositoryType = assembly.GetTypes().Single(t => t.Name == "IOrderRepository");
        var fakeType = assembly.GetTypes().Single(t => t.Name == "FakeOrderRepository");
        var fake = Activator.CreateInstance(fakeType);

        repositoryType.IsInstanceOfType(fake).ShouldBeTrue();
    }

    // ------------------------------------------------------------------
    // Issue #1591 — Task 2: TestSupport.RunApi boots an in-process host over
    // a driver's ApiHostDriver.Build(), so a real HttpClient can drive the
    // emitted endpoints. This trivial fixture proves the harness mechanics
    // (compile, boot, real HTTP round-trip) without any emitted routes yet:
    // an unmapped path 404s via ASP.NET Core's default routing fallthrough.
    // ------------------------------------------------------------------

    private const string TrivialApiHostDriver = """
        using Microsoft.AspNetCore.Builder;
        using Microsoft.AspNetCore.Hosting;
        using Microsoft.AspNetCore.TestHost;
        using Microsoft.Extensions.Hosting;

        public static class ApiHostDriver
        {
            public static WebApplication Build()
            {
                var builder = WebApplication.CreateBuilder();
                builder.WebHost.UseTestServer();
                var app = builder.Build();
                app.Start();
                return app;
            }
        }
        """;

    [Fact]
    public async Task RunApi_boots_a_test_host_and_returns_a_working_http_client()
    {
        using var harness = TestSupport.RunApi(Array.Empty<EmittedFile>(), TrivialApiHostDriver);

        var response = await harness.Client.GetAsync("/does-not-exist", TestContext.Current.CancellationToken);

        response.StatusCode.ShouldBe(HttpStatusCode.NotFound);
    }

    // ------------------------------------------------------------------
    // Issue #1591 — Task 3/4: real HTTP round-trips over the emitted
    // Sales api layer, wiring the Task 1 fake into the Task 2 harness via
    // the emitted AddSalesApplication()/MapSalesEndpoints() extensions.
    // ------------------------------------------------------------------

    /// <summary>
    /// <see cref="Fixture"/> minus its <c>service</c>/<c>readmodel</c>/<c>query</c> blocks: only the
    /// <c>Order</c> aggregate, its repository, and the <c>place</c> command / <c>open</c> factory. Used
    /// for the HTTP round-trip facts below instead of <see cref="Fixture"/> itself because the emitted
    /// <c>GET /order-by-id</c> query endpoint's <c>[AsParameters] OrderById query</c> binding crashes
    /// ASP.NET Core's endpoint-metadata inference at the FIRST request to ANY route on the host (not
    /// just that one) — <c>OrderId</c> has no <c>TryParse</c>, so a GET-illegal inferred-body binding is
    /// the only source Minimal APIs can fall back to for a non-primitive, non-route, non-header
    /// property. That is a real emitter gap (filed as #1649), out of scope for this test-only harness;
    /// this fixture sidesteps it so the command/factory endpoints can still be runtime-verified for real.
    /// </summary>
    internal const string CommandsOnlyFixture = """
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
        }
        """;

    /// <summary>
    /// Boots <see cref="TestSupport.RunApi"/> over <see cref="CommandsOnlyFixture"/> emitted with
    /// <paramref name="options"/>, wiring the emitted <c>AddSalesApplication()</c> DI extension, the
    /// Task 1 <c>FakeOrderRepository</c>/<c>FakeUnitOfWork</c> double (registered as the sole
    /// <c>IUnitOfWork</c>), and the emitted <c>MapSalesEndpoints()</c> — a real, in-process ASP.NET
    /// Core host for the Sales context's endpoints.
    /// </summary>
    private static TestSupport.ApiHostHarness RunSalesApi(CSharpEmitterOptions options) =>
        TestSupport.RunApi(
            Emit(options, CommandsOnlyFixture)
                .Append(new EmittedFile("FakeOrderRepository.cs", FakeOrderRepositorySource.Source)),
            SalesApiHostDriver);

    private const string SalesApiHostDriver = """
        using Microsoft.AspNetCore.Builder;
        using Microsoft.AspNetCore.Hosting;
        using Microsoft.AspNetCore.TestHost;
        using Microsoft.Extensions.DependencyInjection;
        using Microsoft.Extensions.Hosting;

        namespace Sales;

        public static class ApiHostDriver
        {
            public static WebApplication Build()
            {
                var builder = WebApplication.CreateBuilder();
                builder.WebHost.UseTestServer();
                builder.Services.AddSalesApplication();

                var repository = new FakeOrderRepository();
                builder.Services.AddSingleton<IUnitOfWork>(new FakeUnitOfWork(repository));

                var app = builder.Build();
                app.MapSalesEndpoints();
                app.Start();
                return app;
            }
        }
        """;

    [Fact]
    public async Task Api_layer_factory_endpoint_returns_a_real_200_with_the_created_order()
    {
        using var harness = RunSalesApi(ApiOn);

        var response = await harness.Client.PostAsJsonAsync(
            "/order/open",
            new { customer = new { value = Guid.NewGuid() }, total = new { amount = 42.50m, currency = "USD" } },
            TestContext.Current.CancellationToken);

        var body = await response.Content.ReadAsStringAsync(TestContext.Current.CancellationToken);
        response.StatusCode.ShouldBe(HttpStatusCode.OK, body);
        body.ShouldContain("42.5");
        body.ShouldContain("USD");
    }

    [Fact]
    public async Task Api_layer_command_endpoint_returns_a_real_200()
    {
        using var harness = RunSalesApi(ApiOn);

        var openResponse = await harness.Client.PostAsJsonAsync(
            "/order/open",
            new { customer = new { value = Guid.NewGuid() }, total = new { amount = 10m, currency = "EUR" } },
            TestContext.Current.CancellationToken);
        var opened = await openResponse.Content.ReadAsStringAsync(TestContext.Current.CancellationToken);
        openResponse.StatusCode.ShouldBe(HttpStatusCode.OK, opened);
        var orderId = JsonDocument.Parse(opened).RootElement.GetProperty("id").GetProperty("value").GetGuid();

        var placeResponse = await harness.Client.PostAsJsonAsync(
            "/order/place",
            new { id = new { value = orderId } },
            TestContext.Current.CancellationToken);

        var placed = await placeResponse.Content.ReadAsStringAsync(TestContext.Current.CancellationToken);
        placeResponse.StatusCode.ShouldBe(HttpStatusCode.OK, placed);
    }

    /// <summary>
    /// Issue #1591 Task 4: a real HTTP 404 for a missing aggregate. The plan's own sketch drives this
    /// through the <c>GetById</c> query endpoint, but that endpoint crashes the whole host at runtime
    /// (a real emitter bug found while implementing Task 3, filed as #1649) — <c>OrderPlaceHandler</c>
    /// hits the exact same "aggregate not found" path internally (it looks the order up before placing
    /// it), and its endpoint carries the identical <c>NotFound</c> HTTP mapping
    /// (<c>result is null ? Results.NotFound() : Results.Ok(result)</c> under <c>Nullable</c>,
    /// <c>result.IsSuccess ? Results.Ok(result.Value) : Results.NotFound()</c> under <c>Result</c>), so
    /// POSTing <c>/order/place</c> for an id nothing was ever opened under proves the same
    /// HTTP-visible behavior — a real 404 over the wire — without the query endpoint's crash.
    /// </summary>
    [Fact]
    public async Task Api_layer_nullable_not_found_returns_a_real_404_for_a_missing_aggregate()
    {
        using var harness = RunSalesApi(ApiOn with { NotFound = CSharpNotFound.Nullable });

        var response = await harness.Client.PostAsJsonAsync(
            "/order/place",
            new { id = new { value = Guid.NewGuid() } },
            TestContext.Current.CancellationToken);

        response.StatusCode.ShouldBe(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task Api_layer_result_not_found_returns_a_real_404_for_a_missing_aggregate()
    {
        using var harness = RunSalesApi(ApiOn with { NotFound = CSharpNotFound.Result });

        var response = await harness.Client.PostAsJsonAsync(
            "/order/place",
            new { id = new { value = Guid.NewGuid() } },
            TestContext.Current.CancellationToken);

        response.StatusCode.ShouldBe(HttpStatusCode.NotFound);
    }

    // ------------------------------------------------------------------
    // Issue #1649: the GetById query endpoint's [AsParameters] OrderId binding now works
    // (EmitIdValueObject emits TryParse), so Fixture's readmodel/query — which CommandsOnlyFixture
    // above exists solely to sidestep — can be runtime-verified for real.
    // ------------------------------------------------------------------

    /// <summary>
    /// <see cref="Fixture"/> minus its <c>OrdersByStatus</c> list query: that query's criterion is an
    /// enum (<c>status: OrderStatus</c>), which has the same "no TryParse" binding gap #1649 fixed for
    /// typed IDs, but for a genuinely different reason — a C# <c>enum</c> cannot declare a static
    /// <c>TryParse</c> member the way a hand-emitted identity value object can. Since ASP.NET Core
    /// builds endpoint metadata for the WHOLE route table on the first request, that query's crash
    /// would poison every route here too and mask the fix this file exists to verify. Filed as #1656,
    /// out of scope for #1649; this fixture sidesteps it so <c>OrderById</c> can still be
    /// runtime-verified for real.
    /// </summary>
    internal const string QueryableFixture = """
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

          readmodel OrderSummary from Order {
            id
            customer
            status
          }

          query OrderById(id: OrderId): OrderSummary
        }
        """;

    /// <summary>
    /// <see cref="RunSalesApi"/>'s query-enabled counterpart: boots <see cref="TestSupport.RunApi"/>
    /// over <see cref="QueryableFixture"/> (readmodel and <c>OrderById</c> query included), wiring the
    /// same Task 1 fake repository/unit-of-work double.
    /// </summary>
    private static TestSupport.ApiHostHarness RunSalesApiWithQueries(CSharpEmitterOptions options) =>
        TestSupport.RunApi(
            Emit(options, QueryableFixture)
                .Append(new EmittedFile("FakeOrderRepository.cs", FakeOrderRepositorySource.Source)),
            SalesApiHostDriver);

    [Fact]
    public async Task Api_layer_query_endpoint_returns_a_real_200_for_an_existing_order()
    {
        using var harness = RunSalesApiWithQueries(ApiOn);

        var openResponse = await harness.Client.PostAsJsonAsync(
            "/order/open",
            new { customer = new { value = Guid.NewGuid() }, total = new { amount = 15m, currency = "GBP" } },
            TestContext.Current.CancellationToken);
        var opened = await openResponse.Content.ReadAsStringAsync(TestContext.Current.CancellationToken);
        openResponse.StatusCode.ShouldBe(HttpStatusCode.OK, opened);
        var orderId = JsonDocument.Parse(opened).RootElement.GetProperty("id").GetProperty("value").GetGuid();

        var response = await harness.Client.GetAsync(
            $"/order-by-id?id={orderId}", TestContext.Current.CancellationToken);
        var body = await response.Content.ReadAsStringAsync(TestContext.Current.CancellationToken);

        response.StatusCode.ShouldBe(HttpStatusCode.OK, body);
        body.ShouldContain(orderId.ToString());
        body.ShouldContain("Draft");
    }

    [Fact]
    public async Task Api_layer_query_endpoint_returns_a_real_404_for_a_missing_order()
    {
        using var harness = RunSalesApiWithQueries(ApiOn with { NotFound = CSharpNotFound.Nullable });

        var response = await harness.Client.GetAsync(
            $"/order-by-id?id={Guid.NewGuid()}", TestContext.Current.CancellationToken);

        response.StatusCode.ShouldBe(HttpStatusCode.NotFound);
    }

    // ------------------------------------------------------------------
    // Issue #1656: an enum-typed query criterion (OrdersByStatus.Status: OrderStatus) binds correctly
    // instead of crashing the whole host on the first request. Unlike OrderById, OrdersByStatus is a
    // LIST query with no derivable store query, so its handler always throws NotImplementedException
    // by design (see Task_4's List_query_without_a_derivable_store_query_throws_not_implemented) —
    // reaching that throw (instead of the endpoint-metadata InvalidOperationException this issue
    // reports) IS the proof the enum criterion bound successfully.
    // ------------------------------------------------------------------

    /// <summary><see cref="RunSalesApiWithQueries"/>'s counterpart over the full <see cref="Fixture"/>
    /// (both <c>OrderById</c> and the enum-criterion <c>OrdersByStatus</c>).</summary>
    private static TestSupport.ApiHostHarness RunSalesApiWithAllQueries(CSharpEmitterOptions options) =>
        TestSupport.RunApi(
            Emit(options, Fixture)
                .Append(new EmittedFile("FakeOrderRepository.cs", FakeOrderRepositorySource.Source)),
            SalesApiHostDriver);

    [Fact]
    public async Task Api_layer_enum_query_criterion_does_not_poison_the_whole_route_table()
    {
        using var harness = RunSalesApiWithAllQueries(ApiOn);

        // The bug: building endpoint metadata for the OrdersByStatus route throws for the WHOLE
        // CompositeEndpointDataSource on the first request to ANY route — so an unrelated,
        // already-working endpoint failing here would mean the enum query is still poisoning the host.
        var response = await harness.Client.PostAsJsonAsync(
            "/order/open",
            new { customer = new { value = Guid.NewGuid() }, total = new { amount = 5m, currency = "EUR" } },
            TestContext.Current.CancellationToken);

        response.StatusCode.ShouldBe(HttpStatusCode.OK);
    }

    [Fact]
    public async Task Api_layer_enum_query_criterion_binds_from_the_query_string_instead_of_crashing()
    {
        using var harness = RunSalesApiWithAllQueries(ApiOn);

        // NotImplementedException (the handler's by-design stub for a non-derivable list query) proves
        // the request reached the handler — i.e. [AsParameters] bound `status` successfully. The
        // pre-fix crash surfaces as InvalidOperationException ("Body was inferred...") instead.
        var thrown = await Should.ThrowAsync<Exception>(() =>
            harness.Client.GetAsync("/orders-by-status?status=Placed", TestContext.Current.CancellationToken));

        thrown.ShouldNotBeOfType<InvalidOperationException>();
    }

    [Fact]
    public async Task Api_layer_enum_query_criterion_rejects_an_unrecognized_value_with_a_clean_400()
    {
        using var harness = RunSalesApiWithAllQueries(ApiOn);

        var response = await harness.Client.GetAsync(
            "/orders-by-status?status=Bogus", TestContext.Current.CancellationToken);

        response.StatusCode.ShouldBe(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Api_layer_enum_query_criterion_binds_case_insensitively()
    {
        using var harness = RunSalesApiWithAllQueries(ApiOn);

        var thrown = await Should.ThrowAsync<Exception>(() =>
            harness.Client.GetAsync("/orders-by-status?status=placed", TestContext.Current.CancellationToken));

        thrown.ShouldNotBeOfType<InvalidOperationException>();
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

    [Fact]
    public void Not_found_result_wraps_a_command_handler_return()
    {
        var files = Emit(AppOn with { NotFound = CSharpNotFound.Result });

        // The void `place` command's handler now returns Result<Order>, yielding NotFound() on a miss and
        // Ok(aggregate) on a hit. The whole model still compiles (Emit asserts the Koine compile succeeds).
        var handler = File(files, "OrderPlaceHandler.cs").Contents;
        handler.ShouldContain("using Koine.Runtime;");
        handler.ShouldContain("public async Task<Result<Order>> HandleAsync(OrderPlaceRequest request, CancellationToken ct = default)");
        handler.ShouldContain("if (aggregate is null)");
        handler.ShouldContain("return Result<Order>.NotFound();");
        handler.ShouldContain("return Result<Order>.Ok(aggregate);");
        handler.ShouldNotContain("throw new InvalidOperationException");
        handler.ShouldNotContain("return null;");
    }

    [Fact]
    public void Not_found_result_makes_a_by_id_query_handler_return_a_result()
    {
        var files = Emit(AppOn with { NotFound = CSharpNotFound.Result });

        // OrderById is a by-identity query — it now returns Result<OrderSummary> and yields NotFound() on a miss.
        var handler = File(files, "OrderByIdHandler.cs").Contents;
        handler.ShouldContain("Koine.Runtime.IQueryHandler<OrderById, Result<OrderSummary>>");
        handler.ShouldContain("public async Task<Result<OrderSummary>> HandleAsync(OrderById query, CancellationToken ct = default)");
        handler.ShouldContain("return Result<OrderSummary>.NotFound();");
        handler.ShouldContain("return Result<OrderSummary>.Ok(aggregate.ToOrderSummary());");
        handler.ShouldNotContain("throw new InvalidOperationException");
    }

    [Fact]
    public void Not_found_result_application_output_roslyn_compiles()
    {
        // Prove the emitted Result<T> + the wrapped command/query handlers are valid C# — the emitted
        // artifact, not just a clean Koine compile.
        var (assembly, errors) = TestSupport.Compile(Emit(AppOn with { NotFound = CSharpNotFound.Result }));
        assembly.ShouldNotBeNull(string.Join("\n", errors));
    }

    [Fact]
    public void Not_found_result_output_is_stable_and_the_default_stays_byte_identical()
    {
        // The result branch must not perturb the throw (default) output.
        TestSupport.Render(Emit(AppOn with { NotFound = CSharpNotFound.Throw }))
            .ShouldBe(TestSupport.Render(Emit(AppOn)));
    }

    [Fact]
    public void Api_layer_result_not_found_maps_a_command_endpoint_to_200_or_404()
    {
        var endpoints = File(Emit(ApiOn with { NotFound = CSharpNotFound.Result }), "SalesEndpoints.cs").Contents;
        endpoints.ShouldContain("return result.IsSuccess ? Results.Ok(result.Value) : Results.NotFound();");
    }

    /// <summary>Compile-checks the <c>Result&lt;T&gt;</c> not-found policy's endpoint mapping — the
    /// exact surface #1041 introduced (issue #1148).</summary>
    [Fact]
    public void Api_layer_result_not_found_output_compiles()
    {
        var (assembly, errors) = TestSupport.Compile(Emit(ApiOn with { NotFound = CSharpNotFound.Result }));
        assembly.ShouldNotBeNull(string.Join("\n", errors));
    }

    [Fact]
    public void Api_layer_result_maps_only_the_result_returning_endpoints()
    {
        // The command (place) and the by-id query (OrderById) return Result<T> → mapped. The factory
        // (open, plain aggregate) and the list query (OrdersByStatus, plain list) must stay plain Ok —
        // mapping .IsSuccess on those would not compile, so the by-id detection must exclude them.
        var endpoints = File(Emit(ApiOn with { NotFound = CSharpNotFound.Result }), "SalesEndpoints.cs").Contents;
        System.Text.RegularExpressions.Regex.Matches(endpoints, "result.IsSuccess").Count.ShouldBe(2);
        endpoints.ShouldContain("return Results.Ok(result);");
    }

    // ------------------------------------------------------------------
    // W1 (#1041) — --app-handler-result readModel: a void command's handler
    // returns a read-model projection of the mutated aggregate instead of
    // the aggregate. void (default) / aggregate are unchanged.
    // ------------------------------------------------------------------

    [Fact]
    public void Config_parses_application_handler_result_read_model()
    {
        var opts = KoineConfig
            .Parse("targets.csharp.application.handlerResult = readModel\n")
            .OptionsFor("csharp");
        opts.ApplicationHandlerResult.ShouldBe("readModel");
    }

    [Fact]
    public void App_handler_result_read_model_flag_implies_the_application_layer()
    {
        var settings = new BuildSettings { Path = "x.koi", AppHandlerResult = "readModel" };
        settings.TryResolve(out var plan, out var error).ShouldBeTrue(error);
        plan.Options.Layers.ShouldBe(new[] { "domain", "application" });
        plan.Options.ApplicationHandlerResult.ShouldBe("readModel");
    }

    [Fact]
    public void Known_app_handler_result_read_model_resolves_true_case_insensitively()
    {
        new BuildSettings { Path = "x.koi", AppHandlerResult = "readmodel" }
            .TryResolve(out _, out var e1).ShouldBeTrue(e1);
        new BuildSettings { Path = "x.koi", AppHandlerResult = "readModel" }
            .TryResolve(out _, out var e2).ShouldBeTrue(e2);
    }

    [Fact]
    public void Handler_result_read_model_returns_a_projection_of_the_mutated_aggregate()
    {
        var files = Emit(AppOn with { HandlerResult = CSharpHandlerResult.ReadModel });

        // The void `place` command's handler now returns the OrderSummary read model projected from the
        // mutated Order, via the emitted To<RM>() projection, instead of returning nothing.
        var handler = File(files, "OrderPlaceHandler.cs").Contents;
        handler.ShouldContain("public async Task<OrderSummary> HandleAsync(OrderPlaceRequest request, CancellationToken ct = default)");
        handler.ShouldContain("aggregate.Place();");
        handler.ShouldContain("return aggregate.ToOrderSummary();");
        handler.ShouldNotContain("return aggregate;");
    }

    [Fact]
    public void Handler_result_read_model_composes_with_the_nullable_not_found_policy()
    {
        var files = Emit(AppOn with { HandlerResult = CSharpHandlerResult.ReadModel, NotFound = CSharpNotFound.Nullable });
        var handler = File(files, "OrderPlaceHandler.cs").Contents;
        handler.ShouldContain("public async Task<OrderSummary?> HandleAsync(");
        handler.ShouldContain("return null;");
        handler.ShouldContain("return aggregate.ToOrderSummary();");
    }

    [Fact]
    public void Handler_result_read_model_output_roslyn_compiles()
    {
        var (assembly, errors) = TestSupport.Compile(Emit(AppOn with { HandlerResult = CSharpHandlerResult.ReadModel }));
        assembly.ShouldNotBeNull(string.Join("\n", errors));
    }

    [Fact]
    public void Handler_result_read_model_falls_back_to_the_aggregate_without_a_read_model()
    {
        // An aggregate with no read model cannot project, so readModel falls back to returning the
        // mutated aggregate.
        const string src = """
            context Sales {
              enum OrderStatus { Draft, Placed }
              aggregate Order root Order {
                repository { operations: getById, add }
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
        var handler = File(Emit(AppOn with { HandlerResult = CSharpHandlerResult.ReadModel }, src), "OrderPlaceHandler.cs").Contents;
        handler.ShouldContain("public async Task<Order> HandleAsync(");
        handler.ShouldContain("return aggregate;");
    }

    // ------------------------------------------------------------------
    // W1 (#1041) — the two options composed, and their less-travelled
    // branches (declared-return command, MediatR mode, the api layer).
    // ------------------------------------------------------------------

    [Fact]
    public void Not_found_result_composes_with_read_model_handler_result()
    {
        // readModel + result: a void command's handler returns Result<OrderSummary> wrapping the To<RM>()
        // projection on a hit and NotFound() on a miss.
        var handler = File(Emit(AppOn with { HandlerResult = CSharpHandlerResult.ReadModel, NotFound = CSharpNotFound.Result }),
            "OrderPlaceHandler.cs").Contents;
        handler.ShouldContain("public async Task<Result<OrderSummary>> HandleAsync(");
        handler.ShouldContain("return Result<OrderSummary>.NotFound();");
        handler.ShouldContain("return Result<OrderSummary>.Ok(aggregate.ToOrderSummary());");
    }

    [Fact]
    public void Not_found_result_wraps_a_declared_return_command()
    {
        // A command that declares its own return type keeps it, wrapped in Result<declared> — a distinct
        // path from the promoted-void command that the other result tests exercise.
        const string src = """
            context Sales {
              enum OrderStatus { Draft, Placed }
              aggregate Order root Order {
                repository { operations: getById, add }
                entity Order identified by OrderId {
                  status: OrderStatus = Draft
                  total:  Int = 0
                  command bump(by: Int): Int {
                    total -> total + by
                    result total
                  }
                }
              }
            }
            """;
        var handler = File(Emit(AppOn with { NotFound = CSharpNotFound.Result }, src), "OrderBumpHandler.cs").Contents;
        handler.ShouldContain("public async Task<Result<int>> HandleAsync(");
        handler.ShouldContain("return Result<int>.NotFound();");
        handler.ShouldContain("var result = aggregate.Bump(request.By);");
        handler.ShouldContain("return Result<int>.Ok(result);");
    }

    [Fact]
    public void Not_found_result_composes_with_mediatr_mode()
    {
        // Under MediatR the wrapped result flows through the two-arg IRequest/IRequestHandler shape.
        var files = Emit(AppOn with { NotFound = CSharpNotFound.Result, ApplicationMediatr = true });
        File(files, "OrderPlaceRequest.cs").Contents
            .ShouldContain("public sealed record OrderPlaceRequest(OrderId Id) : MediatR.IRequest<Result<Order>>;");
        var handler = File(files, "OrderPlaceHandler.cs").Contents;
        handler.ShouldContain("MediatR.IRequestHandler<OrderPlaceRequest, Result<Order>>");
        handler.ShouldContain("public async Task<Result<Order>> Handle(OrderPlaceRequest request, CancellationToken cancellationToken)");
        handler.ShouldContain("return Result<Order>.Ok(aggregate);");
    }

    [Fact]
    public void Api_layer_read_model_returns_the_projected_body()
    {
        // Regression: an --app-handler-result readModel command endpoint must return the projected read
        // model (Results.Ok(result)), not discard it with an empty Results.Ok().
        var endpoints = File(Emit(ApiOn with { HandlerResult = CSharpHandlerResult.ReadModel }), "SalesEndpoints.cs").Contents;
        endpoints.ShouldContain("var result = await handler.HandleAsync(request, ct);");
        endpoints.ShouldContain("return Results.Ok(result);");
        endpoints.ShouldNotContain("return Results.Ok();");
    }

    /// <summary>Compile-checks the <c>readModel</c> handler-result endpoint mapping — the #1041
    /// surface (issue #1148).</summary>
    [Fact]
    public void Api_layer_read_model_handler_result_output_compiles()
    {
        var (assembly, errors) = TestSupport.Compile(Emit(ApiOn with { HandlerResult = CSharpHandlerResult.ReadModel }));
        assembly.ShouldNotBeNull(string.Join("\n", errors));
    }

    // ------------------------------------------------------------------
    // R19 (#1219) — the api layer honors the @route / @get|@post|@put|
    // @delete|@patch / @auth annotations, via the shared RouteDerivation.
    // The three axes are independent: each falls back to the convention on
    // its own, so an un-annotated model's endpoints stay byte-identical.
    // ------------------------------------------------------------------

    /// <summary>A command carrying all three annotations plus a query carrying only <c>@auth</c> — the
    /// latter keeps the conventional <c>GET /order-by-id</c>, proving route/verb/role are independent.</summary>
    internal const string AnnotatedApiFixture = """
        context Sales {
          enum OrderStatus { Draft, Placed }

          aggregate Order root Order {
            repository {
              operations: getById
            }

            entity Order identified by OrderId {
              status: OrderStatus = Draft

              @route("/orders/{id}")
              @put
              @auth("admin")
              command place {
                requires status == Draft   "order must be a draft to place"
                status -> Placed
              }
            }
          }

          readmodel OrderSummary from Order {
            id
            status
          }

          @auth("admin")
          query OrderById(id: OrderId): OrderSummary
        }
        """;

    /// <summary>
    /// The route's <c>{id}</c> token has no matching command parameter, so it binds to the aggregate
    /// identity (#1748) — an explicit <c>[FromRoute]</c> parameter ahead of the request, re-bound into
    /// it via <c>with { Id = id }</c> so the URL and the loaded aggregate can never disagree.
    /// </summary>
    [Fact]
    public void Api_layer_maps_an_annotated_command_to_its_overridden_verb_and_route()
    {
        var endpoints = File(Emit(ApiOn, AnnotatedApiFixture), "SalesEndpoints.cs").Contents;
        endpoints.ShouldContain(
            "endpoints.MapPut(\"/orders/{id}\", async ([Microsoft.AspNetCore.Mvc.FromRoute(Name = \"id\")] OrderId id, OrderPlaceRequest request, OrderPlaceHandler handler, CancellationToken ct) =>");
        endpoints.ShouldContain("handler.HandleAsync(request with { Id = id }, ct)");
        endpoints.ShouldNotContain("MapPost");
        endpoints.ShouldNotContain("/order/place");
    }

    [Fact]
    public void Api_layer_requires_authorization_for_an_auth_annotated_command()
    {
        var endpoints = File(Emit(ApiOn, AnnotatedApiFixture), "SalesEndpoints.cs").Contents;
        endpoints.ShouldContain("}).RequireAuthorization(\"admin\");");
    }

    /// <summary>An <c>@auth</c>-only query keeps the conventional <c>MapGet</c> at the conventional
    /// route and merely gains the authorization call — the role axis is independent of route/verb.</summary>
    [Fact]
    public void Api_layer_requires_authorization_for_an_auth_annotated_query_without_moving_it()
    {
        var endpoints = File(Emit(ApiOn, AnnotatedApiFixture), "SalesEndpoints.cs").Contents;
        endpoints.ShouldContain(
            "endpoints.MapGet(\"/order-by-id\", async ([AsParameters] OrderById query, OrderByIdHandler handler, CancellationToken ct) =>");
        endpoints.ShouldContain("return Results.Ok(result);\n        }).RequireAuthorization(\"admin\");");
    }

    /// <summary>The un-annotated <see cref="Fixture"/> must gain nothing — no stray authorization call.</summary>
    [Fact]
    public void Api_layer_adds_no_authorization_to_an_unannotated_model()
    {
        File(Emit(ApiOn), "SalesEndpoints.cs").Contents.ShouldNotContain("RequireAuthorization");
    }

    /// <summary>The emitted <c>MapPut</c>/<c>RequireAuthorization</c> chain has to resolve against the
    /// ASP.NET shared framework, not just read right (issue #1148's harness).</summary>
    [Fact]
    public void Api_layer_annotated_output_compiles()
    {
        var (assembly, errors) = TestSupport.Compile(Emit(ApiOn, AnnotatedApiFixture));
        assembly.ShouldNotBeNull(string.Join("\n", errors));
    }

    // ------------------------------------------------------------------
    // #1219 review — a body-less verb (@get/@delete) on a command. ASP.NET
    // disables INFERRED body binding for GET/DELETE/HEAD/OPTIONS/TRACE/
    // CONNECT, so a command mapped through one still needs its request
    // record bound EXPLICITLY. Without [FromBody] the endpoint compiles and
    // then throws at endpoint-build time ("Body was inferred but the method
    // does not allow inferred body parameters") — i.e. at app startup, which
    // the Roslyn compile meta-test cannot see. So these assert the emitted
    // TEXT, not just that it compiles.
    // ------------------------------------------------------------------

    /// <summary>A command carrying a body-less verb — the shape §15.9 of the reference documents.</summary>
    private static string BodylessVerbFixture(string verb) => $$"""
        context Sales {
          enum OrderStatus { Draft, Placed, Cancelled }

          aggregate Order root Order {
            repository {
              operations: getById
            }

            entity Order identified by OrderId {
              status: OrderStatus = Draft

              @route("/orders/{id}")
              @{{verb}}
              command cancel {
                requires status == Draft   "only a draft order can be cancelled"
                status -> Cancelled
              }
            }
          }
        }
        """;

    [Theory]
    [InlineData("delete", "MapDelete")]
    [InlineData("get", "MapGet")]
    public void Api_layer_binds_a_body_less_verbs_request_with_an_explicit_FromBody(string verb, string mapMethod)
    {
        var endpoints = File(Emit(ApiOn, BodylessVerbFixture(verb)), "SalesEndpoints.cs").Contents;

        // The route's {id} token binds to the aggregate identity (#1748) — its [FromRoute] parameter
        // comes first, ahead of the still-explicit [FromBody] request the body-less verb needs.
        endpoints.ShouldContain(
            $"endpoints.{mapMethod}(\"/orders/{{id}}\", async ([Microsoft.AspNetCore.Mvc.FromRoute(Name = \"id\")] OrderId id, [Microsoft.AspNetCore.Mvc.FromBody] OrderCancelRequest request, OrderCancelHandler handler, CancellationToken ct) =>");
    }

    /// <summary>
    /// The attribute is written by fully-qualified name like the rest of this layer, so the endpoints
    /// file gains no <c>using Microsoft.AspNetCore.Mvc;</c> (which would drag in the MVC package).
    /// </summary>
    [Fact]
    public void Api_layer_body_less_verb_binding_adds_no_mvc_using()
    {
        var endpoints = File(Emit(ApiOn, BodylessVerbFixture("delete")), "SalesEndpoints.cs").Contents;

        endpoints.ShouldNotContain("using Microsoft.AspNetCore.Mvc;");
    }

    /// <summary>
    /// The verbs that DO define body semantics keep inferred binding — no attribute — so every endpoint
    /// emitted before R19 stays byte-identical. <c>@put</c> and the conventional <c>POST</c> both.
    /// </summary>
    [Fact]
    public void Api_layer_leaves_a_body_taking_verbs_request_binding_untouched()
    {
        File(Emit(ApiOn, AnnotatedApiFixture), "SalesEndpoints.cs").Contents
            .ShouldContain("endpoints.MapPut(\"/orders/{id}\", async ([Microsoft.AspNetCore.Mvc.FromRoute(Name = \"id\")] OrderId id, OrderPlaceRequest request, OrderPlaceHandler handler, CancellationToken ct) =>");

        // The conventional (unannotated) route carries no {token}, so it stays untouched by both
        // FromBody (body-taking verb) and FromRoute (#1748: no route override, no bindings).
        var conventional = File(Emit(ApiOn), "SalesEndpoints.cs").Contents;
        conventional.ShouldContain("endpoints.MapPost(\"/order/place\", async (OrderPlaceRequest request,");
        conventional.ShouldNotContain("FromBody");
        conventional.ShouldNotContain("FromRoute");
    }

    /// <summary>And it still has to compile against the ASP.NET shared framework.</summary>
    [Fact]
    public void Api_layer_body_less_verb_output_compiles()
    {
        var (assembly, errors) = TestSupport.Compile(Emit(ApiOn, BodylessVerbFixture("delete")));
        assembly.ShouldNotBeNull(string.Join("\n", errors));
    }
}
