using Koine.Runtime;
using Kernel = Menu__Ordering.Kernel;

namespace Pizzeria.Domain;

/// <summary>
/// Hand-written code that USES the Koine-generated pizzeria domain types, proving the
/// generated C# is real, compilable, and ergonomic. None of the types below are
/// declared here — every one is emitted from the <c>.koi</c> files in
/// <c>templates/pizzeria</c>, compiled in directory mode so cross-context imports,
/// the context map, and integration events resolve across files.
/// </summary>
public static class Samples
{
    /// <summary>
    /// Opens a delivery order through its factory (<c>Order.Open</c> — the all-args
    /// constructor is private once a <c>create</c> exists), then drives it through the
    /// <c>place</c> command (preconditions, state transition, invariant re-check,
    /// domain event). Exercises the <c>OrderLine</c> pricing value object: the second
    /// line has 6 pizzas, so its <c>payable</c> gets the "5+ → 10% off" deal (R1.1),
    /// and the shared-kernel <c>Currency</c> flows through Money unchanged (R14.2).
    /// </summary>
    public static Ordering.Order BuildOrder()
    {
        var eur = Kernel.Currency.EUR;
        var lines = new[]
        {
            new Ordering.OrderLine(new Ordering.PizzaCode("MARGHERITA"), 2, new Ordering.Money(9.50m, eur)),
            new Ordering.OrderLine(new Ordering.PizzaCode("PEPPERONI"), 6, new Ordering.Money(12.00m, eur)), // 5+ => 10% off
        };

        // Factory; emits OrderOpened. A delivery order so it routes into Delivery downstream.
        var order = Ordering.Order.Open(Ordering.CustomerId.New(), Ordering.Fulfillment.Delivery, lines);
        order.Place();          // Draft -> Placed; stamps placedAt; re-checks invariants; emits OrderPlacedInternally

        _ = order.Total;        // lines.sum(l => l.payable)
        _ = order.LineCount;    // 2
        _ = order.IsPlaced;     // placedAt.isPresent => true
        _ = order.IsDelivery;   // fulfillment == Delivery => true
        _ = order.Version;      // optimistic-concurrency token (aggregate is `versioned`)
        _ = order.DomainEvents; // OrderOpened + OrderPlacedInternally (R6); ClearDomainEvents() after dispatch

        Ordering.OrderSummary summary = Ordering.OrderSummaryProjection.ToOrderSummary(order); // read-model projection (R12.3)
        _ = summary.LineCount;
        return order;
    }

    /// <summary>
    /// Opens a kitchen ticket through its factory and runs it through the full kitchen
    /// workflow state machine (R7): queued → prepping → baking → ready → served. The
    /// ticket reuses Menu's imported <c>Topping</c> value object (R13.2 — Kitchen
    /// conforms to Menu), and lives in the <c>Kitchen.Line</c> module sub-namespace
    /// (R13.3). Returns the served ticket so Program.cs can assert the terminal stage.
    /// </summary>
    public static Kitchen.Line.KitchenTicket BuildKitchenTicket()
    {
        var eur = Kernel.Currency.EUR;
        var toppings = new[]
        {
            // Topping is Menu's VO, imported into Kitchen; its Money uses the kernel Currency.
            new Menu.Topping("Pepperoni", new Menu.Money(1.50m, eur), new Menu.Portion(40m, Menu.MassUnit.Gram)),
        };

        var ticket = Kitchen.Line.KitchenTicket.Open(
            Kitchen.OrderId.New(),          // each context owns its OrderId (ID convention)
            Kitchen.Station.OvenA,
            pizzas: 2,
            toppings: toppings);

        ticket.Prep();    // Queued -> Prepping
        ticket.Bake();    // Prepping -> Baking; stamps startedAt; emits TicketStartedBaking
        ticket.PutUp();   // Baking -> Ready
        ticket.Serve();   // Ready -> Served (terminal)

        _ = ticket.Started; // startedAt.isPresent => true after Bake()
        _ = ticket.IsDone;  // stage == Served => true
        return ticket;
    }

    /// <summary>
    /// Schedules a delivery through its factory, exercising the rule that ANCHORS the
    /// Delivery context: a delivery order requires a delivery address. The
    /// <c>Address</c> value object validates shape (postal-code regex) and the
    /// aggregate re-checks the "needs an address" invariant. Then drives the delivery
    /// lifecycle: pick up (assigns a Courier) → depart → complete.
    /// </summary>
    public static Delivery.Delivery BuildDelivery()
    {
        var destination = new Delivery.Address("12 Dough Street", "Napoli", "80100", "IT");

        // Factory; requires a non-blank street; emits DeliveryScheduled.
        var delivery = Delivery.Delivery.Schedule(Delivery.OrderId.New(), destination);

        delivery.PickUp(new Delivery.Courier("Mario", "+39 555 0100")); // Scheduled -> PickedUp; assigns courier
        delivery.Depart();    // PickedUp -> EnRoute (requires a courier)
        delivery.Complete();  // EnRoute -> Delivered; emits DeliveryCompleted

        _ = delivery.Assigned;     // courier.isPresent => true
        _ = delivery.IsDelivered;  // status == Delivered => true
        _ = destination.Formatted; // "12 Dough Street, Napoli 80100"
        return delivery;
    }

    /// <summary>
    /// Authorizes and captures a charge through the Payment aggregate's factory and
    /// commands. The root entity is <c>Charge</c> (not <c>Payment</c>, which would
    /// collide with the namespace); Payment's <c>Money</c> keeps currency as a loose
    /// String because Payment is downstream of the shared kernel (see context-map.koi).
    /// </summary>
    public static Payment.Charge BuildCharge()
    {
        var charge = Payment.Charge.Authorize(
            Payment.OrderId.New(),
            new Payment.Money(30.10m, "EUR"),
            Payment.PaymentMethod.Card);

        charge.Capture();   // Authorized -> Captured; emits ChargeCaptured (the ledger policy reacts)

        _ = charge.IsSettled; // status == Captured => true
        return charge;
    }
}
