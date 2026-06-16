using Catalog;        // brings the generated ProductCardProjection.ToProductCard extension into scope
using Koine.Runtime;

namespace Shop.Domain;

/// <summary>
/// Hand-written infrastructure that IMPLEMENTS the seams Koine emits as interfaces:
/// a repository, an application service, a query handler, an integration-event
/// subscriber, a cross-aggregate policy handler, and an anti-corruption translator.
/// This is the other half of the demo — the generated code defines the contracts,
/// these adapters satisfy them, and <see cref="RunAsync"/> drives a use case through
/// the whole stack and asserts the result. None of the interfaces are declared here.
/// </summary>
public static class Consumers
{
    // R11.2/R11.3 — an in-memory IOrderRepository (incl. the byCustomer / mostRecent finders).
    private sealed class InMemoryOrderRepository : Ordering.IOrderRepository
    {
        private readonly List<Ordering.Order> _orders = new();

        public Task<Ordering.Order?> GetByIdAsync(Ordering.OrderId id, CancellationToken ct = default) =>
            Task.FromResult(_orders.FirstOrDefault(o => o.Id.Equals(id)));

        public Task AddAsync(Ordering.Order aggregate, CancellationToken ct = default)
        {
            _orders.Add(aggregate);
            return Task.CompletedTask;
        }

        public Task UpdateAsync(Ordering.Order aggregate, CancellationToken ct = default)
        {
            // A real adapter would enforce the optimistic-concurrency Version here.
            var index = _orders.FindIndex(o => o.Id.Equals(aggregate.Id));
            if (index >= 0)
            {
                _orders[index] = aggregate;
            }

            return Task.CompletedTask;
        }

        public Task<IReadOnlyList<Ordering.Order>> ByCustomerAsync(Ordering.CustomerId customer, CancellationToken ct = default) =>
            Task.FromResult<IReadOnlyList<Ordering.Order>>(_orders.Where(o => o.Customer.Equals(customer)).ToList());

        public Task<Ordering.Order?> MostRecentAsync(Ordering.CustomerId customer, CancellationToken ct = default) =>
            Task.FromResult(_orders.LastOrDefault(o => o.Customer.Equals(customer)));
    }

    // R12.2 — an IOrderingService use-case implementation wired to the repository above.
    private sealed class OrderingService : Ordering.IOrderingService
    {
        private readonly Ordering.IOrderRepository _orders;
        public OrderingService(Ordering.IOrderRepository orders) => _orders = orders;

        public async Task<Ordering.OrderId> PlaceOrder(
            Ordering.CustomerId customer,
            IReadOnlyList<Ordering.OrderLine> lines,
            CancellationToken ct = default)
        {
            var order = Ordering.Order.Open(customer, lines); // factory; emits OrderOpened
            order.Submit();                                   // Draft -> Submitted; emits OrderSubmitted
            await _orders.AddAsync(order, ct);
            return order.Id;
        }

        public async Task CancelOrder(Ordering.OrderId order, CancellationToken ct = default)
        {
            var found = await _orders.GetByIdAsync(order, ct)
                ?? throw new InvalidOperationException($"order {order.Value} not found");
            found.Cancel();
            await _orders.UpdateAsync(found, ct);
        }
    }

    // R12.4 — a query handler returning ProductCards, satisfying IQueryHandler<TQuery, TResult>.
    private sealed class ProductsByAvailabilityHandler
        : IQueryHandler<Catalog.ProductsByAvailability, IReadOnlyList<Catalog.ProductCard>>
    {
        private readonly IReadOnlyList<Catalog.Product> _products;
        public ProductsByAvailabilityHandler(IReadOnlyList<Catalog.Product> products) => _products = products;

        public Task<IReadOnlyList<Catalog.ProductCard>> HandleAsync(
            Catalog.ProductsByAvailability query, CancellationToken ct = default) =>
            Task.FromResult<IReadOnlyList<Catalog.ProductCard>>(
                _products
                    .Where(p => p.Availability == query.Availability)
                    .Select(p => p.ToProductCard()) // generated projection mapper
                    .ToList());
    }

    // R14.3 — the integration-event subscriber Payments emits as IHandleOrderPlaced.
    private sealed class AuthorizePaymentOnOrderPlaced : Payments.IHandleOrderPlaced
    {
        public Payments.Payment? LastAuthorized { get; private set; }

        public Task Handle(Ordering.OrderPlaced theEvent, CancellationToken ct = default)
        {
            LastAuthorized = Payments.Payment.Authorize(
                new Payments.OrderId(theEvent.OrderId.Value),
                new Payments.Money(theEvent.Total, "EUR"),
                Payments.PaymentMethod.Card);
            return Task.CompletedTask;
        }
    }

    // R10.3 — the cross-aggregate policy handler Koine emits as PostToLedgerPolicy.
    private sealed class PostToLedger : Payments.PostToLedgerPolicy
    {
        private readonly Payments.LedgerEntry _entry;
        public PostToLedger(Payments.LedgerEntry entry) => _entry = entry;

        // Intended reaction (from the model): Ledger.record(amount: e.CapturedAmount).
        public override Task Handle(Payments.PaymentCaptured e, CancellationToken ct = default)
        {
            _entry.Record(e.CapturedAmount);
            return Task.CompletedTask;
        }
    }

    // R14.2 — an anti-corruption translator stub satisfying ILegacyToPaymentsTranslator.
    private sealed class LegacyToPaymentsTranslator : Payments.ILegacyToPaymentsTranslator
    {
        public Payments.PaymentReceipt Translate(Legacy.GatewayResult source) =>
            new Payments.PaymentReceipt(source.RawReference, source.RawAmount);
    }

    /// <summary>Drives each seam end-to-end and asserts the result.</summary>
    public static async Task RunAsync()
    {
        Console.WriteLine("\nConsumer seams");

        // Repository + application service: place an order, then read it back via a finder.
        var repo = new InMemoryOrderRepository();
        var service = new OrderingService(repo);
        var customer = Ordering.CustomerId.New();
        var eur = Catalog__Ordering.Kernel.Currency.EUR;
        var lines = new[]
        {
            new Ordering.OrderLine(Ordering.ProductId.New(), 2, new Ordering.Money(5.00m, eur)),
        };

        var placedId = await service.PlaceOrder(customer, lines);
        var roundTripped = await repo.GetByIdAsync(placedId);
        Require(roundTripped is not null && roundTripped.Status == Ordering.OrderStatus.Submitted,
            "IOrderingService.PlaceOrder persisted a Submitted order via the repository");

        var byCustomer = await repo.ByCustomerAsync(customer);
        Require(byCustomer.Count == 1, "IOrderRepository.ByCustomer finder returns the placed order");

        await service.CancelOrder(placedId);
        var afterCancel = await repo.GetByIdAsync(placedId);
        Require(afterCancel!.Status == Ordering.OrderStatus.Cancelled, "IOrderingService.CancelOrder transitions the order to Cancelled");

        // Query handler returning ProductCards.
        var catalog = new[] { Samples.BuildProduct() };
        var handler = new ProductsByAvailabilityHandler(catalog);
        var cards = await handler.HandleAsync(new Catalog.ProductsByAvailability(Catalog.Availability.InStock));
        Require(cards.Count == 1 && cards[0].Available, "ProductsByAvailability query handler projects an in-stock ProductCard");

        // Integration-event subscriber.
        var subscriber = new AuthorizePaymentOnOrderPlaced();
        await subscriber.Handle(new Ordering.OrderPlaced(Ordering.OrderId.New(), customer, 51.57m, DateTimeOffset.UtcNow));
        Require(subscriber.LastAuthorized is not null && subscriber.LastAuthorized.Status == Payments.PaymentStatus.Authorized,
            "IHandleOrderPlaced subscriber authorized a payment for the placed order");

        // Cross-aggregate policy handler.
        var ledger = new Payments.LedgerEntry(Payments.LedgerEntryId.New(), Payments.PaymentId.New(), 0m);
        var policy = new PostToLedger(ledger);
        await policy.Handle(new Payments.PaymentCaptured(Payments.PaymentId.New(), 131.95m));
        Require(ledger.Balance == 131.95m, "PostToLedger policy handler posted the captured amount to the ledger");

        // Anti-corruption translator.
        var translator = new LegacyToPaymentsTranslator();
        var receipt = translator.Translate(new Legacy.GatewayResult("LGCY-9", 42m));
        Require(receipt.Reference == "LGCY-9" && receipt.Amount == 42m, "ILegacyToPaymentsTranslator maps a legacy GatewayResult into a PaymentReceipt");
    }

    private static void Require(bool condition, string what)
    {
        if (!condition)
        {
            throw new Exception($"DEMO ASSERTION FAILED: {what}");
        }

        Console.WriteLine($"  ok  {what}");
    }
}
