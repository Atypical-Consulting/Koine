using Koine.Runtime;

namespace Pizzeria.Domain;

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
            Ordering.Fulfillment fulfillment,
            IReadOnlyList<Ordering.OrderLine> lines,
            CancellationToken ct = default)
        {
            var order = Ordering.Order.Open(customer, fulfillment, lines); // factory; emits OrderOpened
            order.Place();                                                 // Draft -> Placed; emits OrderPlacedInternally
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

    // R12.4 — a query handler returning OrderSummaries, satisfying IQueryHandler<TQuery, TResult>.
    private sealed class OrdersByStatusHandler
        : IQueryHandler<Ordering.OrdersByStatus, IReadOnlyList<Ordering.OrderSummary>>
    {
        private readonly IReadOnlyList<Ordering.Order> _orders;
        public OrdersByStatusHandler(IReadOnlyList<Ordering.Order> orders) => _orders = orders;

        public Task<IReadOnlyList<Ordering.OrderSummary>> HandleAsync(
            Ordering.OrdersByStatus query, CancellationToken ct = default) =>
            Task.FromResult<IReadOnlyList<Ordering.OrderSummary>>(
                _orders
                    .Where(o => o.Status == query.Status)
                    .Select(Ordering.OrderSummaryProjection.ToOrderSummary) // generated projection mapper (R12.3)
                    .ToList());
    }

    // R14.3 — the integration-event subscriber Payment emits as IHandleOrderPlaced.
    // Authorizes a charge when Ordering announces OrderPlaced.
    private sealed class AuthorizeChargeOnOrderPlaced : Payment.IHandleOrderPlaced
    {
        public Payment.Charge? LastAuthorized { get; private set; }

        public Task Handle(Ordering.OrderPlaced theEvent, CancellationToken ct = default)
        {
            // The integration event carries only primitives, so map its OrderId into Payment's own.
            LastAuthorized = Payment.Charge.Authorize(
                new Payment.OrderId(theEvent.OrderId.Value),
                new Payment.Money(theEvent.Total, "EUR"),
                Payment.PaymentMethod.Card);
            return Task.CompletedTask;
        }
    }

    // R10.3 — the cross-aggregate policy handler Koine emits as PostToLedgerPolicy.
    private sealed class PostToLedger : Payment.PostToLedgerPolicy
    {
        private readonly Payment.LedgerEntry _entry;
        public PostToLedger(Payment.LedgerEntry entry) => _entry = entry;

        // Intended reaction (from the model): Books.record(amount: e.CapturedAmount).
        public override Task Handle(Payment.ChargeCaptured e, CancellationToken ct = default)
        {
            _entry.Record(e.CapturedAmount);
            return Task.CompletedTask;
        }
    }

    // R14.2 — the anti-corruption translator the acl block emits as
    // IGatewayToPaymentTranslator: the external Gateway result -> our clean PaymentReceipt.
    private sealed class GatewayToPaymentTranslator : Payment.IGatewayToPaymentTranslator
    {
        public Payment.PaymentReceipt Translate(Gateway.GatewayResult source) =>
            new Payment.PaymentReceipt(source.RawReference, source.RawAmount);
    }

    /// <summary>Drives each seam end-to-end and asserts the result.</summary>
    public static async Task RunAsync()
    {
        Console.WriteLine("\nConsumer seams");

        // Repository + application service: place an order, then read it back via a finder.
        var repo = new InMemoryOrderRepository();
        var service = new OrderingService(repo);
        var customer = Ordering.CustomerId.New();
        var eur = Menu__Ordering.Kernel.Currency.EUR;
        var lines = new[]
        {
            new Ordering.OrderLine(new Ordering.PizzaCode("MARGHERITA"), 2, new Ordering.Money(9.50m, eur)),
        };

        var placedId = await service.PlaceOrder(customer, Ordering.Fulfillment.Pickup, lines);
        var roundTripped = await repo.GetByIdAsync(placedId);
        Require(roundTripped is not null && roundTripped.Status == Ordering.OrderStatus.Placed,
            "IOrderingService.PlaceOrder persisted a Placed order via the repository");

        var byCustomer = await repo.ByCustomerAsync(customer);
        Require(byCustomer.Count == 1, "IOrderRepository.ByCustomer finder returns the placed order");

        await service.CancelOrder(placedId);
        var afterCancel = await repo.GetByIdAsync(placedId);
        Require(afterCancel!.Status == Ordering.OrderStatus.Cancelled, "IOrderingService.CancelOrder transitions the order to Cancelled");

        // Query handler returning OrderSummaries.
        var board = new[] { Samples.BuildOrder() }; // a Placed delivery order
        var handler = new OrdersByStatusHandler(board);
        var placed = await handler.HandleAsync(new Ordering.OrdersByStatus(Ordering.OrderStatus.Placed));
        Require(placed.Count == 1 && placed[0].Status == Ordering.OrderStatus.Placed,
            "OrdersByStatus query handler projects the placed order to an OrderSummary");

        // Integration-event subscriber: Payment authorizes a charge on OrderPlaced.
        var subscriber = new AuthorizeChargeOnOrderPlaced();
        await subscriber.Handle(new Ordering.OrderPlaced(
            Ordering.OrderId.New(), customer, Ordering.Fulfillment.Delivery, 30.10m, DateTimeOffset.UtcNow));
        Require(subscriber.LastAuthorized is not null && subscriber.LastAuthorized.Status == Payment.ChargeStatus.Authorized,
            "IHandleOrderPlaced subscriber authorized a charge for the placed order");

        // Cross-aggregate policy handler: ChargeCaptured -> post to the ledger.
        var ledger = new Payment.LedgerEntry(Payment.LedgerEntryId.New(), Payment.ChargeId.New(), 0m);
        var policy = new PostToLedger(ledger);
        await policy.Handle(new Payment.ChargeCaptured(Payment.ChargeId.New(), 30.10m));
        Require(ledger.Balance == 30.10m, "PostToLedger policy handler posted the captured amount to the ledger");

        // Anti-corruption translator: the external gateway's raw result -> our PaymentReceipt.
        var translator = new GatewayToPaymentTranslator();
        var receipt = translator.Translate(new Gateway.GatewayResult("GW-9", 42m));
        Require(receipt.Reference == "GW-9" && receipt.Amount == 42m,
            "IGatewayToPaymentTranslator maps a gateway GatewayResult into a PaymentReceipt");
    }

    private static void Require(bool condition, string what) =>
        Console.WriteLine(condition ? $"  ok  {what}" : throw new Exception($"DEMO ASSERTION FAILED: {what}"));
}
