using Koine.Runtime;
using Pizzeria.Domain;

// Runnable demo entry point. Everything below USES the Koine-generated pizzeria types
// and ASSERTS the documented outcomes, so `dotnet run --project demo/Pizzeria.Domain`
// is a self-checking proof that the generated domain code behaves as advertised — and,
// because the project generates straight from templates/pizzeria, that the pizzeria
// TEMPLATE emits compiling, runnable C# end-to-end. A non-zero exit code (a failed
// assertion or a thrown invariant) breaks the build's `dotnet run`, so green here means
// the demo is correct end-to-end.

static void Check(bool condition, string what) =>
    Console.WriteLine(condition ? $"  ok  {what}" : throw new Exception($"DEMO ASSERTION FAILED: {what}"));

static void Throws<TException>(Action action, string what) where TException : Exception
{
    try
    {
        action();
    }
    catch (TException)
    {
        Console.WriteLine($"  ok  {what} (threw {typeof(TException).Name})");
        return;
    }
    throw new Exception($"DEMO ASSERTION FAILED: expected {typeof(TException).Name} — {what}");
}

Console.WriteLine("Koine demo — exercising the generated Pizzeria domain\n");

// --- Ordering: factory, command, derived total with the "5+ pizzas → 10% off" deal ---
Console.WriteLine("Ordering");
var order = Samples.BuildOrder();
// Documented total: 2 * 9.50 + (6 * 12.00) * 0.9  =  19.00 + 64.80  =  83.80
var expectedTotal = 2 * 9.50m + 6 * 12.00m * 0.9m;
Check(order.Total.Amount == expectedTotal, $"order.Total == {expectedTotal} (2*9.50 + 6*12.00*0.9 — 10% off the 6-pizza line)");
Check(order.Total.Currency == Menu__Ordering.Kernel.Currency.EUR, "order.Total.Currency == EUR (shared-kernel Currency flows through Money)");
Check(order.LineCount == 2, "order.LineCount == 2");
Check(order.IsPlaced, "order.IsPlaced (placedAt.isPresent after Place)");
Check(order.IsDelivery, "order.IsDelivery (fulfillment == Delivery)");
Check(order.Status == Ordering.OrderStatus.Placed, "order.Status == Placed");
Check(order.DomainEvents.Count == 2, "order raised OrderOpened + OrderPlacedInternally");
Throws<DomainInvariantViolationException>(() => order.Place(), "placing an already-placed order is rejected");

// --- Kitchen: module aggregate, imported Topping VO, full workflow state machine -----
Console.WriteLine("\nKitchen");
var ticket = Samples.BuildKitchenTicket();
Check(ticket.Stage == Kitchen.TicketStage.Served, "ticket.Stage == Served after prep→bake→putUp→serve");
Check(ticket.Started, "ticket.Started (startedAt stamped on Bake)");
Check(ticket.Toppings.Count == 1, "ticket carries 1 imported Menu.Topping (R13.2 conformist import)");
Throws<DomainInvariantViolationException>(() => ticket.Bake(), "baking an already-served ticket is rejected (illegal transition)");

// --- Delivery: the Address value object + the "delivery requires an address" rule ----
Console.WriteLine("\nDelivery");
var delivery = Samples.BuildDelivery();
Check(delivery.Status == Delivery.DeliveryStatus.Delivered, "delivery.Status == Delivered after pickUp→depart→complete");
Check(delivery.Assigned, "delivery.Assigned (a courier was assigned at pick-up)");
Check(delivery.Destination.Formatted == "12 Dough Street, Napoli 80100", "Address.Formatted composes the one-line address");
// The anchoring invariant: a delivery order requires a (non-blank) delivery address.
Throws<DomainInvariantViolationException>(
    () => Delivery.Delivery.Schedule(Delivery.OrderId.New(), new Delivery.Address("   ", "Napoli", "80100", "IT")),
    "scheduling a delivery with a blank street is rejected (a delivery requires an address)");

// --- Payment: factory, command, and the anti-corruption layer over the Gateway -------
Console.WriteLine("\nPayment");
var charge = Samples.BuildCharge();
Check(charge.Status == Payment.ChargeStatus.Captured, "charge.Status == Captured after Capture()");
Check(charge.IsSettled, "charge.IsSettled (status == Captured)");
Throws<DomainInvariantViolationException>(() => charge.Capture(), "capturing an already-captured charge is rejected");

// --- Consumer seams: repositories, services, query handlers, subscribers, ACL --------
await Consumers.RunAsync();

Console.WriteLine("\nAll demo assertions passed.");
