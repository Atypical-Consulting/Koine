using Catalog;
using Customers;
using Ordering;

namespace Shop.Domain;

/// <summary>
/// Hand-written code that USES the Koine-generated domain types, proving the
/// generated C# is real, compilable, and ergonomic. None of the types below are
/// declared here — they are emitted from the <c>.koi</c> models in Models/.
/// Each bounded context maps to one namespace (<c>Catalog</c>, <c>Customers</c>,
/// <c>Ordering</c>).
/// </summary>
public static class Samples
{
    /// <summary>
    /// Builds a catalog product, exercising optional fields (<c>description</c>,
    /// <c>sale</c>), a <c>Set</c> (<c>tags</c>), a soft-keyword field
    /// (<c>Weight.value</c>), and derived string/comparison/presence fields.
    /// </summary>
    public static Product BuildProduct()
    {
        var sale = new SalePeriod(DateTimeOffset.UtcNow, DateTimeOffset.UtcNow.AddDays(7));

        var product = new Product(
            Catalog.ProductId.New(),
            new Sku("  abc-1234  "),                            // normalized => "ABC-1234"
            "Mechanical Keyboard",
            new Price(129.95m, Catalog.Currency.EUR),
            new Weight(1.1m, "kg"),                             // Weight.value is a soft-keyword field
            new HashSet<string> { "input", "rgb", "input" },    // Set dedupes -> 2 tags
            Availability.InStock,
            description: "Tactile, hot-swappable",
            sale: sale);

        // Derived fields computed by the generated type:
        _ = product.Sku.Normalized;  // "ABC-1234"  (trim + upper)
        _ = product.Summary;         // description ?? name
        _ = product.IsAvailable;     // availability == InStock
        _ = product.OnSale;          // sale.isPresent => true
        return product;
    }

    /// <summary>
    /// Builds a customer, exercising optional fields with coalescing
    /// (<c>displayName = nickname ?? name</c>), a presence check, a derived
    /// conditional (<c>freeShipping</c>), and a Set of segments.
    /// </summary>
    public static Customer BuildCustomer() =>
        new(
            Customers.CustomerId.New(),
            "Ada Lovelace",
            new Email("  Ada@Example.com  "),                   // normalized => "ada@example.com"
            new PostalAddress("1 Analytical Way", "London", "EC1A 1AA", "UK"),
            new HashSet<string> { "early-adopter", "newsletter" },
            LoyaltyTier.Gold,
            nickname: "Ada");                                   // displayName => "Ada"; phone unset

    /// <summary>
    /// Builds a draft order with multiple lines, then drives it through the
    /// <c>submit</c> command (R5) — exercising preconditions, state transitions
    /// (<c>status</c>, <c>submittedAt</c>), and the post-transition invariant
    /// re-check — plus collection ops (<c>total</c>, <c>lineCount</c>), a
    /// conditional bulk discount (<c>payable</c>), and a scoped enum comparison.
    /// </summary>
    public static Ordering.Order BuildOrder()
    {
        var eur = Ordering.Currency.EUR;
        var lines = new[]
        {
            new OrderLine(Ordering.ProductId.New(), 3, new Money(9.99m, eur)),   // payable = lineTotal
            new OrderLine(Ordering.ProductId.New(), 12, new Money(2.00m, eur)),  // 10+ => 10% off
        };

        // Construct as a Draft (status/refund/submittedAt default), then submit.
        var order = new Ordering.Order(OrderId.New(), Ordering.CustomerId.New(), lines);
        order.Submit();        // Draft -> Submitted; stamps submittedAt; re-checks invariants; emits OrderSubmitted

        _ = order.Total;       // lines.sum(l => l.payable)
        _ = order.LineCount;   // 2
        _ = order.IsPlaced;    // submittedAt.isPresent => true (set by submit)
        _ = order.IsCancelled; // status == Cancelled (OrderStatus) => false
        _ = order.DomainEvents; // contains one OrderSubmitted (R6); ClearDomainEvents() after dispatch
        return order;
    }
}
