using Koine.Runtime;
using Customers;                       // spec extension methods (customer.IsVip())
using Kernel = Catalog__Ordering.Kernel;

namespace Shop.Domain;

/// <summary>
/// Hand-written code that USES the Koine-generated domain types, proving the
/// generated C# is real, compilable, and ergonomic. None of the types below are
/// declared here — every one is emitted from the <c>.koi</c> models in Models/,
/// compiled in directory mode so cross-context imports, the context map, and
/// integration events resolve across files.
/// </summary>
public static class Samples
{
    /// <summary>
    /// Builds a catalog product. Exercises a natural string identity
    /// (<c>ProductCode</c>, no <c>New()</c>), an associated-data enum
    /// (<c>Currency</c>, a shared-kernel type), a <c>quantity</c> value object
    /// (<c>Weight</c>), a <c>Range&lt;Instant&gt;</c> (<c>SalePeriod</c>),
    /// optional fields, a uniqueness <c>Set</c>, and derived fields.
    /// </summary>
    public static Catalog.Product BuildProduct()
    {
        var window = new Range<DateTimeOffset>(DateTimeOffset.UtcNow, DateTimeOffset.UtcNow.AddDays(7));

        var product = new Catalog.Product(
            new Catalog.ProductCode("KEYBOARD-01"),             // natural string key (no New())
            new Catalog.Sku("ABC-1234"),                        // raw passes /^[A-Z]{3}-[0-9]{4}$/; Normalized => "ABC-1234"
            "Mechanical Keyboard",
            new Catalog.Price(129.95m, Kernel.Currency.EUR),    // Currency is a shared-kernel enum
            new Catalog.Weight(1.1m, Catalog.MassUnit.Kilogram),
            new HashSet<string> { "input", "rgb", "input" },    // Set dedupes -> 2 tags
            Catalog.Availability.InStock,
            description: "Tactile, hot-swappable",
            sale: new Catalog.SalePeriod(window),
            barcode: "5901234123457");                          // field added @since(2)

        _ = product.Sku.Normalized;             // "ABC-1234"  (trim + upper)
        _ = product.Weight + product.Weight;    // unit-checked quantity arithmetic
        _ = product.Summary;                    // description ?? name
        _ = product.IsAvailable;                // availability == InStock
        _ = product.OnSale;                     // sale.isPresent => true
        return product;                         // Program.cs asserts these outcomes
    }

    /// <summary>
    /// Builds a customer and exercises the generated specification
    /// (<c>customer.IsVip()</c> extension method) and domain service
    /// (<c>LoyaltyService.DiscountRate</c>).
    /// </summary>
    public static Customers.Customer BuildCustomer()
    {
        var customer = new Customers.Customer(
            Customers.CustomerId.New(),
            "Ada Lovelace",
            new Customers.Email("  Ada@Example.com  "),         // normalized => "ada@example.com"
            new Customers.PostalAddress("1 Analytical Way", "London", "EC1A 1AA", "UK"),
            new HashSet<string> { "early-adopter", "newsletter" },
            Customers.LoyaltyTier.Gold,
            nickname: "Ada");                                   // displayName => "Ada"

        _ = customer.IsVip();  // spec extension method => true (Gold)
        _ = new Customers.LoyaltyService().DiscountRate(customer.Tier); // 0.10 for Gold
        return customer;
    }

    /// <summary>
    /// Opens an order through its factory (<c>Order.Open</c> — the all-args
    /// constructor is private once a <c>create</c> exists), drives it through the
    /// <c>submit</c> command (preconditions, state transition, invariant re-check,
    /// domain event), and projects it to a read model.
    /// </summary>
    public static Ordering.Order BuildOrder()
    {
        var eur = Kernel.Currency.EUR;
        var lines = new[]
        {
            new Ordering.OrderLine(Ordering.ProductId.New(), 3, new Ordering.Money(9.99m, eur)),
            new Ordering.OrderLine(Ordering.ProductId.New(), 12, new Ordering.Money(2.00m, eur)), // 10+ => 10% off
        };

        var order = Ordering.Order.Open(Ordering.CustomerId.New(), lines); // factory; emits OrderOpened
        order.Submit();        // Draft -> Submitted; stamps submittedAt; re-checks invariants; emits OrderSubmitted

        _ = order.Total;       // lines.sum(l => l.payable)
        _ = order.LineCount;   // 2
        _ = order.IsPlaced;    // submittedAt.isPresent => true
        _ = order.Version;     // optimistic-concurrency token (aggregate is `versioned`)
        _ = order.DomainEvents; // OrderOpened + OrderSubmitted (R6); ClearDomainEvents() after dispatch

        Ordering.OrderSummary summary = Ordering.OrderSummaryProjection.ToOrderSummary(order); // read-model projection (R12)
        _ = summary.LineCount;
        return order;
    }

    /// <summary>
    /// Schedules a shipment through its factory. Exercises a module-scoped
    /// aggregate (<c>Shipping.Fulfillment</c>), an imported value object
    /// (<c>PostalAddress</c> from Customers), and a conformist reference to
    /// <c>Catalog.Weight</c>.
    /// </summary>
    public static Shipping.Fulfillment.Shipment BuildShipment()
    {
        var shipment = Shipping.Fulfillment.Shipment.Schedule(
            Shipping.OrderId.New(),                             // each context owns its OrderId (ID convention)
            new Customers.PostalAddress("1 Analytical Way", "London", "EC1A 1AA", "UK"),
            new Catalog.Weight(1.1m, Catalog.MassUnit.Kilogram));

        shipment.Dispatch();   // Pending -> Dispatched (state machine)
        return shipment;
    }

    /// <summary>
    /// Authorizes and captures a payment through the payment aggregate's factory
    /// and commands. The Payments context also subscribes to the
    /// <c>Ordering.OrderPlaced</c> integration event (see IHandleOrderPlaced).
    /// </summary>
    public static Payments.Payment BuildPayment()
    {
        var payment = Payments.Payment.Authorize(
            Payments.OrderId.New(),
            new Payments.Money(131.95m, "EUR"),
            Payments.PaymentMethod.Card);

        payment.Capture();     // Authorized -> Captured
        return payment;
    }
}
