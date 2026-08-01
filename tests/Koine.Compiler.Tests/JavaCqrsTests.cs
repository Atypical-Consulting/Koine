using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// The application / CQRS slice of the Java backend (issue #1090, Phase 2 Task 1) — the Java analogue of
/// <c>PythonEmitter.Cqrs.cs</c> and <c>CSharpEmitter.Cqrs.cs</c>. Phase 1 (PR #1069) shipped the tactical
/// core only, so a model's <c>service</c> / <c>readmodel</c> / <c>query</c> declarations emitted
/// <b>nothing</b> for <c>--target java</c>. This suite locks the three shapes Phase 2 adds:
/// <list type="bullet">
///   <item>a <c>service</c>'s boundary as one <c>public interface</c> — pure domain operations as
///   <c>default</c> (bodied) or abstract (seam) methods, application use cases as
///   <c>CompletableFuture</c>-returning methods (the stdlib async analogue of C#'s <c>Task</c> and
///   Python's <c>async def</c>);</item>
///   <item>a <c>readmodel</c> as an immutable <c>record</c> plus a static <c>from(src)</c> projection —
///   the Java analogue of C#'s <c>To&lt;Name&gt;</c> extension and Python's <c>to_&lt;name&gt;</c>;</item>
///   <item>a <c>query</c> as a criteria <c>record</c> plus a <c>&lt;Q&gt;Handler</c> interface
///   specializing the shared runtime <c>koine.runtime.QueryHandler&lt;Q, R&gt;</c> seam.</item>
/// </list>
/// The fixture mirrors <see cref="Conformance.TypeScriptCqrsSnapshotTests"/>'s, so the targets stay
/// comparable construct-for-construct.
/// </summary>
public class JavaCqrsTests
{
    /// <summary>A focused CQRS cross-section (service + use cases, read model with a derived field, query).</summary>
    internal const string Fixture = """
        context Sales {
          enum OrderStatus { Draft, Placed, Cancelled }

          value OrderLine {
            sku:      String
            quantity: Int
            invariant quantity >= 1 "a line needs at least one unit"
          }

          aggregate Order root Order {
            entity Order identified by OrderId {
              customer: CustomerId
              lines:    List<OrderLine>
              status:   OrderStatus = Draft

              command place {
                requires status == Draft "only a draft order can be placed"
                status -> Placed
              }
            }
          }

          /// R12.2 — the application-service boundary.
          service OrderingService {
            /// Places a new order, returning its identity.
            usecase PlaceOrder(customer: CustomerId, lines: List<OrderLine>): OrderId
            /// Cancels an order (fire-and-forget).
            usecase CancelOrder(order: OrderId)
          }

          /// R12.3 — a flat read model + projection mapper for an order board.
          readmodel OrderSummary from Order {
            id
            customer
            status
            lineCount: Int = lines.count
          }

          /// R12.4 — a query DTO over the read model.
          query OrdersByStatus(status: OrderStatus): List<OrderSummary>
        }
        """;

    /// <summary>
    /// A <c>readmodel</c> emits an immutable positional <c>record</c> of the projected fields plus a
    /// static <c>from(&lt;Src&gt; src)</c> projection: a direct field copies the like-named source member
    /// through its accessor, a derived field translates its projection rooted at <c>src</c>.
    /// </summary>
    [Fact]
    public void Read_model_emits_a_record_with_a_static_projection()
    {
        var result = new KoineCompiler().Compile(Fixture, new JavaEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var summary = result.Files
            .Single(f => f.RelativePath.EndsWith("OrderSummary.java", StringComparison.Ordinal)).Contents;

        summary.ShouldContain(
            "public record OrderSummary(OrderId id, CustomerId customer, OrderStatus status, long lineCount) {");
        summary.ShouldContain("public static OrderSummary from(Order src) {");
        // `.size()` is an `int`; the `lineCount` component is Koine `Int` -> Java `long`, so the
        // translator's numeric widening cast is part of the contract, not incidental.
        summary.ShouldContain(
            "return new OrderSummary(src.id(), src.customer(), src.status(), (long) src.lines().size());");
    }

    /// <summary>
    /// A <c>query</c> emits its criteria <c>record</c> and a companion <c>&lt;Q&gt;Handler</c> interface
    /// specializing the shared runtime seam — a <c>List&lt;M&gt;</c> result becoming
    /// <c>java.util.List&lt;M&gt;</c>, matching the repository finders' collection convention.
    /// </summary>
    [Fact]
    public void Query_emits_a_criteria_record_and_a_handler_seam()
    {
        var result = new KoineCompiler().Compile(Fixture, new JavaEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var query = result.Files
            .Single(f => f.RelativePath.EndsWith("OrdersByStatus.java", StringComparison.Ordinal)).Contents;
        query.ShouldContain("public record OrdersByStatus(OrderStatus status) {}");

        var handler = result.Files
            .Single(f => f.RelativePath.EndsWith("OrdersByStatusHandler.java", StringComparison.Ordinal)).Contents;
        handler.ShouldContain(
            "public interface OrdersByStatusHandler extends koine.runtime.QueryHandler<OrdersByStatus, java.util.List<OrderSummary>> {}");
    }

    /// <summary>
    /// The generic <c>QueryHandler&lt;Q, R&gt;</c> runtime seam ships into <c>koine.runtime</c> — but only
    /// when the model actually declares a query, so a query-free model's emit stays byte-identical to
    /// Phase 1's.
    /// </summary>
    [Fact]
    public void Query_handler_runtime_seam_is_emitted_only_when_the_model_has_queries()
    {
        var withQuery = new KoineCompiler().Compile(Fixture, new JavaEmitter());
        withQuery.Files.ShouldContain(f => f.RelativePath == "koine/runtime/QueryHandler.java");
        withQuery.Files.Single(f => f.RelativePath == "koine/runtime/QueryHandler.java").Contents
            .ShouldContain("public interface QueryHandler<Q, R> {");

        const string noQueries = """
            context Sales {
              value Sku {
                code: String
              }
            }
            """;
        var without = new KoineCompiler().Compile(noQueries, new JavaEmitter());
        without.Files.ShouldNotContain(f => f.RelativePath == "koine/runtime/QueryHandler.java");
    }

    /// <summary>
    /// A <c>service</c>'s use cases emit as one <c>public interface</c> whose members return
    /// <c>java.util.concurrent.CompletableFuture&lt;T&gt;</c> (<c>&lt;Void&gt;</c> for a fire-and-forget
    /// use case) — the dependency-free stdlib analogue of the C# emitter's <c>Task</c>-returning
    /// <c>I&lt;Name&gt;</c> boundary.
    /// </summary>
    [Fact]
    public void Application_service_emits_an_interface_of_completable_future_use_cases()
    {
        var result = new KoineCompiler().Compile(Fixture, new JavaEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var service = result.Files
            .Single(f => f.RelativePath.EndsWith("OrderingService.java", StringComparison.Ordinal)).Contents;

        service.ShouldContain("public interface OrderingService {");
        service.ShouldContain(
            "java.util.concurrent.CompletableFuture<OrderId> placeOrder(CustomerId customer, java.util.List<OrderLine> lines);");
        service.ShouldContain("java.util.concurrent.CompletableFuture<Void> cancelOrder(OrderId order);");
    }

    /// <summary>
    /// A <c>service</c>'s pure domain <c>operations</c> (R10.2) emit on the same interface: a bodied
    /// operation becomes a <c>default</c> method carrying its translated result expression, a bodyless
    /// one an abstract seam the consumer implements.
    /// </summary>
    [Fact]
    public void Domain_service_operations_emit_default_and_abstract_methods()
    {
        const string src = """
            context Pricing {
              service PricingService {
                /// A pure, bodied operation.
                operation withTax(net: Decimal, rate: Decimal): Decimal = net + net * rate
                /// A seam the consumer implements.
                operation quote(sku: String): Decimal
              }
            }
            """;
        var result = new KoineCompiler().Compile(src, new JavaEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var service = result.Files
            .Single(f => f.RelativePath.EndsWith("PricingService.java", StringComparison.Ordinal)).Contents;

        service.ShouldContain("default java.math.BigDecimal withTax(java.math.BigDecimal net, java.math.BigDecimal rate) {");
        // BigDecimal carries no operators, so `net + net * rate` lowers to the method form (the inner
        // parens are the translator's own precedence bracketing).
        service.ShouldContain("return net.add((net.multiply(rate)));");
        service.ShouldContain("java.math.BigDecimal quote(String sku);");
    }
}
