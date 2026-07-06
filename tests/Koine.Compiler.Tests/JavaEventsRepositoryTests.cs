using Koine.Compiler.Emit;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// The Java backend's events / repository slice (issue #858, Task 7). A Koine <c>event</c> and
/// cross-boundary <c>integration event</c> emit as immutable positional <c>record</c>s that
/// <c>implements</c> the per-context <c>DomainEvent</c> sealed interface (whose <c>permits</c> list names
/// every event of the context); an aggregate root's <c>repository</c> block emits as a
/// persistence-ignorant <c>interface</c>; and an identity referenced but not owned by a local entity is
/// materialized as a branded <c>record</c> so the reference resolves. A Koine <c>command</c> is a
/// state-changing entity behavior, so it emits as a <b>method</b> on the entity class (Task 6), never a
/// standalone record — Koine has no top-level command type (see
/// <see cref="A_command_is_an_entity_method_not_a_standalone_record"/>).
/// <para>
/// These tests compile small Koine sources through <see cref="JavaEmitter"/> and pin the emitted Java
/// strings (no javac needed): the event record shape and its <c>implements DomainEvent</c>, the sealed
/// <c>DomainEvent</c> sum, the repository interface signatures, and the branded foreign-ID record.
/// </para>
/// </summary>
public class JavaEventsRepositoryTests
{
    // A single aggregate with a top-level integration event, a nested domain event raised by a command,
    // an aggregate-root repository, and a CustomerId referenced but not owned by any local entity.
    private const string OrderingWithEvents =
        "context Ordering {\n" +
        "  integration event OrderExported {\n" +
        "    orderId:    OrderId\n" +
        "    total:      Decimal\n" +
        "    exportedAt: Instant\n" +
        "  }\n" +
        "\n" +
        "  aggregate Sales root Order {\n" +
        "    repository {\n" +
        "      operations: getById, add, update\n" +
        "      find byCustomer(customer: CustomerId): List<Order>\n" +
        "      find mostRecent(customer: CustomerId): Order\n" +
        "    }\n" +
        "\n" +
        "    event OrderPlaced {\n" +
        "      orderId:  OrderId\n" +
        "      customer: CustomerId\n" +
        "    }\n" +
        "\n" +
        "    enum OrderStatus { Draft, Placed }\n" +
        "\n" +
        "    entity Order identified by OrderId {\n" +
        "      customer: CustomerId\n" +
        "      status:   OrderStatus = Draft\n" +
        "      command place {\n" +
        "        requires status == Draft   \"only a draft order can be placed\"\n" +
        "        status -> Placed\n" +
        "        emit OrderPlaced(orderId: id, customer: customer)\n" +
        "      }\n" +
        "    }\n" +
        "  }\n" +
        "}\n";

    [Fact]
    public void A_domain_event_emits_a_positional_record_implementing_DomainEvent()
    {
        var placed = EmitTypeFile(OrderingWithEvents, "OrderPlaced.java");

        // The event is an immutable record whose components are its declared members IN DECLARATION
        // ORDER (the order the entity slice constructs `new OrderPlaced(...)` positionally), implementing
        // the per-context DomainEvent sealed interface.
        placed.ShouldContain("public record OrderPlaced(OrderId orderId, CustomerId customer) implements DomainEvent {}");
        placed.ShouldContain("package koine.generated.ordering;");
    }

    [Fact]
    public void An_integration_event_emits_a_record_implementing_DomainEvent()
    {
        var exported = EmitTypeFile(OrderingWithEvents, "OrderExported.java");

        // A cross-boundary integration event is a record too, and (like a domain event) a DomainEvent —
        // so an entity that raises it can record it in its List<DomainEvent>. Its scalar fields map to
        // fully-qualified stdlib types.
        exported.ShouldContain(
            "public record OrderExported(OrderId orderId, java.math.BigDecimal total, java.time.Instant exportedAt) implements DomainEvent {}");
    }

    [Fact]
    public void The_context_emits_a_sealed_DomainEvent_interface_permitting_every_event()
    {
        var domainEvent = EmitTypeFile(OrderingWithEvents, "DomainEvent.java");

        // The closed sum the recorded-events list is typed on: a sealed interface whose `permits` names
        // every event of the context (the top-level integration event AND the aggregate-nested domain
        // event), each of which `implements DomainEvent`. Ordinal-sorted for determinism.
        domainEvent.ShouldContain("public sealed interface DomainEvent permits OrderExported, OrderPlaced {}");
        domainEvent.ShouldContain("package koine.generated.ordering;");
    }

    [Fact]
    public void A_repository_emits_an_interface_with_the_declared_operations_and_finders()
    {
        var repo = EmitTypeFile(OrderingWithEvents, "OrderRepository.java");

        // A persistence-ignorant interface named after the aggregate root, with the configured mutating
        // operations (getById/add/update — remove was NOT listed) keyed on the branded id, ...
        repo.ShouldContain("public interface OrderRepository {");
        repo.ShouldContain("java.util.Optional<Order> getById(OrderId id);");
        repo.ShouldContain("void add(Order aggregate);");
        repo.ShouldContain("void update(Order aggregate);");
        repo.ShouldNotContain("void remove(");

        // ... plus the declarative finders: a list finder returns List<Root>, a single finder Optional<Root>.
        repo.ShouldContain("java.util.List<Order> byCustomer(CustomerId customer);");
        repo.ShouldContain("java.util.Optional<Order> mostRecent(CustomerId customer);");
    }

    [Fact]
    public void A_foreign_identity_referenced_but_not_locally_owned_emits_a_branded_record()
    {
        var files = EmitAll(OrderingWithEvents);

        // CustomerId is referenced (event payload, entity member, finder parameter) but no local Customer
        // entity owns it, so a minimal branded record is materialized so every reference resolves (javac).
        var customerId = files.Single(f => f.RelativePath.EndsWith("CustomerId.java", StringComparison.Ordinal)).Contents;
        customerId.ShouldContain("public record CustomerId(java.util.UUID value) {}");

        // The owned OrderId is emitted by the entity slice, so it is NOT double-emitted as an unowned id
        // (exactly one OrderId.java, and it carries the entity's full branded shape with a generator).
        files.Count(f => f.RelativePath.EndsWith("OrderId.java", StringComparison.Ordinal)).ShouldBe(1);
        var orderId = files.Single(f => f.RelativePath.EndsWith("OrderId.java", StringComparison.Ordinal)).Contents;
        orderId.ShouldContain("public static OrderId generate() {");
    }

    [Fact]
    public void A_command_is_an_entity_method_not_a_standalone_record()
    {
        var files = EmitAll(OrderingWithEvents);

        // A Koine `command` is a state-changing entity behavior (Task 6), so it surfaces as a method on
        // the entity class — never a standalone record and never a DomainEvent. Only the EVENT it raises
        // is a record.
        var order = files.Single(f => f.RelativePath.EndsWith("Order.java", StringComparison.Ordinal)).Contents;
        order.ShouldContain("public final class Order {");
        order.ShouldContain("public void place() {");
        order.ShouldNotContain("class Order implements");

        // No file materializes the command itself as a record/type.
        files.ShouldNotContain(f => f.RelativePath.EndsWith("Place.java", StringComparison.Ordinal));
    }

    [Fact]
    public void A_context_with_no_events_emits_no_DomainEvent_interface()
    {
        // A pure value/entity context declares no events, so no (empty) DomainEvent sum is emitted.
        var files = EmitAll(
            "context Catalog {\n" +
            "  value Sku {\n" +
            "    code: String\n" +
            "    invariant code != \"\"   \"a sku needs a code\"\n" +
            "  }\n" +
            "}\n");

        files.ShouldNotContain(f => f.RelativePath.EndsWith("DomainEvent.java", StringComparison.Ordinal));
    }

    // ----------------------------------------------------------------------

    /// <summary>Compiles <paramref name="source"/> through the Java emitter and returns the contents of the type file ending in <paramref name="suffix"/>.</summary>
    private static string EmitTypeFile(string source, string suffix) =>
        EmitAll(source).Single(f => f.RelativePath.EndsWith(suffix, StringComparison.Ordinal)).Contents;

    /// <summary>Compiles <paramref name="source"/> through the Java emitter and returns every emitted file.</summary>
    private static IReadOnlyList<EmittedFile> EmitAll(string source)
    {
        var result = new KoineCompiler().Compile(source, new JavaEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        return result.Files;
    }
}
