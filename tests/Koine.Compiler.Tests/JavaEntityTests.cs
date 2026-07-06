using Koine.Compiler.Emit;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// The Java backend's entity/aggregate slice (issue #858, Task 6): a Koine <c>entity</c> emits as a
/// <c>public final class</c> with private fields, a validating constructor, identity-based
/// <c>equals</c>/<c>hashCode</c>, and one invariant-guarded mutating method per behavior; its generated
/// identity emits as a branded <c>record</c> file. An <c>aggregate</c> is a boundary, not a type — its
/// nested declarations are emitted flat, each in its own file. These tests compile small Koine sources
/// through <see cref="JavaEmitter"/> and pin the emitted Java strings (no javac needed): the class shape,
/// the id-based equality, the behavior guard + mutation, the recorded domain events, the generated-ID
/// record, and the aggregate's nested-type recursion.
/// </summary>
public class JavaEntityTests
{
    private const string GuardedOrder =
        "context Ordering {\n" +
        "  enum OrderStatus { Draft, Placed, Cancelled }\n" +
        "  entity Order identified by OrderId {\n" +
        "    status: OrderStatus = Draft\n" +
        "    command place {\n" +
        "      requires status == Draft   \"only a draft order can be placed\"\n" +
        "      status -> Placed\n" +
        "    }\n" +
        "  }\n" +
        "}\n";

    [Fact]
    public void An_entity_emits_a_final_class_with_private_fields_and_identity_equality()
    {
        var order = EmitTypeFile(GuardedOrder, "Order.java");

        // A public final class laid out under the base package + lowercased context.
        order.ShouldContain("public final class Order {");
        order.ShouldContain("package koine.generated.ordering;");

        // Private fields: the identity (always final) and the (behavior-mutated) status field.
        order.ShouldContain("private final OrderId id;");
        order.ShouldContain("private OrderStatus status;");

        // Identity-based equality keyed on the id field.
        order.ShouldContain("public boolean equals(Object o) {");
        order.ShouldContain("if (!(o instanceof Order other)) {");
        order.ShouldContain("return java.util.Objects.equals(this.id, other.id);");
        order.ShouldContain("public int hashCode() {");
        order.ShouldContain("return java.util.Objects.hashCode(this.id);");

        // A read accessor for the identity.
        order.ShouldContain("public OrderId id() {");
    }

    [Fact]
    public void A_mutating_behavior_guards_its_precondition_and_assigns_the_new_state()
    {
        var order = EmitTypeFile(GuardedOrder, "Order.java");

        // The behavior is a public method that throws DomainException when its guard fails, ...
        order.ShouldContain("public void place() {");
        order.ShouldContain("if (!(java.util.Objects.equals(this.status, OrderStatus.Draft))) {");
        order.ShouldContain("throw new koine.runtime.DomainException(\"only a draft order can be placed\");");

        // ... then applies the state transition.
        order.ShouldContain("this.status = OrderStatus.Placed;");
    }

    [Fact]
    public void A_guid_identity_emits_a_uuid_record_in_its_own_file()
    {
        var id = EmitTypeFile(GuardedOrder, "OrderId.java");

        // The generated ID is its own branded record over a java.util.UUID, ...
        id.ShouldContain("public record OrderId(java.util.UUID value) {");
        id.ShouldContain("package koine.generated.ordering;");

        // ... with a client-side minter for a fresh v4 UUID.
        id.ShouldContain("public static OrderId generate() {");
        id.ShouldContain("return new OrderId(java.util.UUID.randomUUID());");
    }

    [Fact]
    public void A_natural_string_identity_validates_non_blank_in_the_record()
    {
        var code = EmitTypeFile(
            "context Catalog {\n" +
            "  entity Product identified by ProductCode as natural(String) {\n" +
            "    name: String\n" +
            "  }\n" +
            "}\n",
            "ProductCode.java");

        // A natural String key wraps a String and guards non-blank in its compact constructor.
        code.ShouldContain("public record ProductCode(String value) {");
        code.ShouldContain("public ProductCode {");
        code.ShouldContain("if (value == null || value.isBlank()) {");
        code.ShouldContain("throw new koine.runtime.DomainException(\"identity value cannot be blank\");");

        // A natural key is not minted, so no UUID generator.
        code.ShouldNotContain("java.util.UUID");
    }

    [Fact]
    public void An_aggregate_recurses_into_each_nested_type_as_its_own_file()
    {
        var files = EmitAll(
            "context Ordering {\n" +
            "  aggregate Sales root Order {\n" +
            "    enum OrderStatus { Draft, Placed, Cancelled }\n" +
            "    value OrderLine {\n" +
            "      quantity:  Int\n" +
            "      unitPrice: Decimal\n" +
            "      subtotal:  Decimal = unitPrice * quantity\n" +
            "    }\n" +
            "    entity Order identified by OrderId {\n" +
            "      lines:  List<OrderLine>\n" +
            "      status: OrderStatus = Draft\n" +
            "    }\n" +
            "  }\n" +
            "}\n");

        // Each nested declaration lands as its own file (one public type per file), plus the generated ID.
        files.ShouldContain(f => f.RelativePath.EndsWith("OrderStatus.java", StringComparison.Ordinal));
        files.ShouldContain(f => f.RelativePath.EndsWith("OrderLine.java", StringComparison.Ordinal));
        files.ShouldContain(f => f.RelativePath.EndsWith("Order.java", StringComparison.Ordinal));
        files.ShouldContain(f => f.RelativePath.EndsWith("OrderId.java", StringComparison.Ordinal));

        // The root entity defensively copies its collection member in the constructor.
        var order = files.Single(f => f.RelativePath.EndsWith("Order.java", StringComparison.Ordinal)).Contents;
        order.ShouldContain("private final java.util.List<OrderLine> lines;");
        order.ShouldContain("this.lines = java.util.List.copyOf(lines);");
    }

    [Fact]
    public void A_behavior_that_emits_an_event_records_it_via_the_domain_event_list()
    {
        var order = EmitTypeFile(
            "context Ordering {\n" +
            "  aggregate Sales root Order {\n" +
            "    enum OrderStatus { Draft, Placed }\n" +
            "    event OrderPlaced { order: OrderId }\n" +
            "    entity Order identified by OrderId {\n" +
            "      status: OrderStatus = Draft\n" +
            "      command place {\n" +
            "        requires status == Draft   \"only a draft order can be placed\"\n" +
            "        status -> Placed\n" +
            "        emit OrderPlaced(order: id)\n" +
            "      }\n" +
            "    }\n" +
            "  }\n" +
            "}\n",
            "Order.java");

        // A recorded-events collector referencing the per-context DomainEvent sealed interface by simple name.
        order.ShouldContain("private final java.util.List<DomainEvent> domainEvents = new java.util.ArrayList<>();");

        // An unmodifiable-snapshot accessor.
        order.ShouldContain("public java.util.List<DomainEvent> domainEvents() {");
        order.ShouldContain("return java.util.List.copyOf(this.domainEvents);");

        // The behavior records the event, binding `id` to the entity's identity field.
        order.ShouldContain("this.domainEvents.add(new OrderPlaced(this.id));");
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
