using Koine.Compiler.Emit;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// The infrastructure / integration slice of the Java backend (issue #1090, Phase 2 Task 5) — the wiring
/// that makes a strategic slice runnable. Two halves, deliberately gated differently, mirroring the
/// C#/Python/TypeScript backends:
/// <list type="bullet">
///   <item><b>Integration subscribers</b> (R14.3) are ALWAYS emitted: a <c>subscribes Pub.Event</c>
///   declaration produces a <c>Handle&lt;Event&gt;</c> delivery seam in the subscribing context, the Java
///   counterpart of the C#/TS <c>IHandle&lt;Event&gt;</c> (Java interfaces carry no <c>I</c> prefix, the
///   same convention the emitted <c>&lt;Root&gt;Repository</c> already follows).</item>
///   <item><b>The infrastructure layer</b> — in-memory repository implementations and the transactional
///   outbox — is OPT-IN behind <c>--layers infrastructure</c> (issue #241), so the default emit stays
///   byte-identical to the domain-only output.</item>
/// </list>
/// </summary>
public class JavaInfrastructureTests
{
    /// <summary>A publishing context with an aggregate + declarative finders, and a subscribing context.</summary>
    internal const string Fixture = """
        contextmap {
          Sales -> Shipping : customer-supplier
        }

        context Sales {
          integration event OrderPlaced {
            orderRef: String
          }

          publishes OrderPlaced

          aggregate Ordering root Order {
            repository {
              operations: getById, add, update
              find byCustomer(customer: CustomerId): List<Order>
              find byRef(orderRef: String): Order
            }

            entity Order identified by OrderId {
              customer: CustomerId
              orderRef: String
            }
          }
        }

        context Shipping {
          subscribes Sales.OrderPlaced

          entity Shipment identified by ShipmentId {
            orderRef: String
          }
        }
        """;

    /// <summary>The emitter built for the opt-in infrastructure layer (<c>--layers infrastructure</c>).</summary>
    private static IEmitter InfrastructureEmitter() =>
        new JavaEmitterProvider().Create(EmitterOptions.Empty with { Layers = "domain,infrastructure" });

    /// <summary>
    /// A <c>subscribes</c> declaration emits a delivery seam in the SUBSCRIBING context, typed on the
    /// publisher's integration event — package-qualified, since the two live in different packages. This
    /// is ungated: the published-language contract is part of the domain model, not of a wiring layer.
    /// </summary>
    [Fact]
    public void Subscription_emits_a_handler_seam_in_the_subscribing_context()
    {
        var result = new KoineCompiler().Compile(Fixture, new JavaEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var handler = result.Files
            .Single(f => f.RelativePath == "koine/generated/shipping/HandleOrderPlaced.java").Contents;

        handler.ShouldContain("public interface HandleOrderPlaced {");
        handler.ShouldContain(
            "java.util.concurrent.CompletableFuture<Void> handle(koine.generated.sales.OrderPlaced event);");
    }

    /// <summary>
    /// The infrastructure layer is off by default: no repository implementation, no outbox, and no
    /// infrastructure runtime types in a plain domain emit.
    /// </summary>
    [Fact]
    public void Infrastructure_is_not_emitted_without_the_layer_selector()
    {
        var result = new KoineCompiler().Compile(Fixture, new JavaEmitter());

        result.Files.ShouldNotContain(f => f.RelativePath.Contains("InMemory", StringComparison.Ordinal));
        result.Files.ShouldNotContain(f => f.RelativePath.Contains("Outbox", StringComparison.Ordinal));
        result.Files.ShouldNotContain(f => f.RelativePath.EndsWith("IntegrationEventDispatcher.java", StringComparison.Ordinal));
    }

    /// <summary>
    /// With <c>--layers infrastructure</c>, each aggregate root gains a concrete in-memory repository
    /// implementing the contract the domain layer already emits, over an injectable
    /// <c>AggregateStore</c> — runnable in tests out of the box, swappable for a real datastore.
    /// </summary>
    [Fact]
    public void Infrastructure_layer_emits_an_in_memory_repository_per_aggregate()
    {
        var result = new KoineCompiler().Compile(Fixture, InfrastructureEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var repo = result.Files
            .Single(f => f.RelativePath == "koine/generated/sales/InMemoryOrderRepository.java").Contents;

        repo.ShouldContain("public final class InMemoryOrderRepository implements OrderRepository {");
        repo.ShouldContain("public InMemoryOrderRepository(koine.runtime.AggregateStore<OrderId, Order> store) {");
        repo.ShouldContain("this(new koine.runtime.InMemoryStore<>(Order::id));");
        repo.ShouldContain("return this.store.get(id);");

        // Only the CONFIGURED operations are implemented — `remove` was not listed, and the contract
        // does not declare it, so implementing it would not even override anything.
        repo.ShouldContain("public void update(Order aggregate) {");
        repo.ShouldNotContain("public void remove(");
    }

    /// <summary>
    /// A declarative finder becomes a concrete in-memory query: each parameter that matches a root member
    /// is a value-equality filter. A list finder returns <c>java.util.List</c>, a single finder
    /// <c>java.util.Optional</c> — the same shapes the emitted contract declares.
    /// </summary>
    [Fact]
    public void Infrastructure_layer_implements_declarative_finders_as_in_memory_queries()
    {
        var result = new KoineCompiler().Compile(Fixture, InfrastructureEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var repo = result.Files
            .Single(f => f.RelativePath == "koine/generated/sales/InMemoryOrderRepository.java").Contents;

        repo.ShouldContain("public java.util.List<Order> byCustomer(CustomerId customer) {");
        repo.ShouldContain(".filter(entity -> java.util.Objects.equals(entity.customer(), customer))");
        repo.ShouldContain("public java.util.Optional<Order> byRef(String orderRef) {");
        repo.ShouldContain(".findFirst();");
    }

    /// <summary>
    /// A PUBLISHING context gains the out-of-band half of the transactional outbox: a dispatcher that
    /// drains unprocessed messages in order, delivers each, and marks it processed. The shared outbox
    /// primitives ship once into <c>koine.runtime</c>.
    /// </summary>
    [Fact]
    public void Infrastructure_layer_emits_the_outbox_and_a_dispatcher_for_a_publishing_context()
    {
        var result = new KoineCompiler().Compile(Fixture, InfrastructureEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        result.Files.ShouldContain(f => f.RelativePath == "koine/runtime/OutboxMessage.java");
        result.Files.ShouldContain(f => f.RelativePath == "koine/runtime/InMemoryOutboxStore.java");

        var dispatcher = result.Files
            .Single(f => f.RelativePath == "koine/generated/sales/IntegrationEventDispatcher.java").Contents;
        dispatcher.ShouldContain("public void dispatchPending() {");
        dispatcher.ShouldContain("this.handler.handle(message);");
        dispatcher.ShouldContain("this.outbox.markProcessed(message);");

        // A subscribe-only context publishes nothing, so it gets no dispatcher.
        result.Files.ShouldNotContain(f =>
            f.RelativePath == "koine/generated/shipping/IntegrationEventDispatcher.java");
    }
}
