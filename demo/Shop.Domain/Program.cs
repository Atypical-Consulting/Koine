using Koine.Runtime;
using Shop.Domain;
using Kernel = Catalog__Ordering.Kernel;

// Runnable demo entry point. Everything below USES the Koine-generated types and
// ASSERTS the documented outcomes, so `dotnet run --project demo/Shop.Domain`
// is a self-checking proof that the generated domain code behaves as advertised.
// A non-zero exit code (a failed assertion or a thrown invariant) breaks the build's
// `dotnet run`, so green here means the demo is correct end-to-end.

static void Check(bool condition, string what)
{
    if (!condition) throw new Exception($"DEMO ASSERTION FAILED: {what}");
    Console.WriteLine($"  ok  {what}");
}

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

Console.WriteLine("Koine demo — exercising the generated Shop domain\n");

// --- Catalog: value objects, normalization, quantity arithmetic -----------------
Console.WriteLine("Catalog");
var product = Samples.BuildProduct();
Check(product.Sku.Normalized == "ABC-1234", "product.Sku.Normalized == \"ABC-1234\" (trim + upper)");
Check(product.Tags.Count == 2, "Set<String> dedupes the duplicate 'input' tag -> 2 tags");
Check(product.IsAvailable, "product.IsAvailable (availability == InStock)");
Check(product.OnSale, "product.OnSale (sale.isPresent)");
Check((product.Weight + product.Weight).Amount == 2.2m, "Weight + Weight = 2.2 kg (unit-checked quantity arithmetic)");

// --- Customers: specifications + domain service ---------------------------------
Console.WriteLine("\nCustomers");
var customer = Samples.BuildCustomer();
Check(Customers.CustomersSpecifications.IsVip(customer), "IsVip(customer) for a Gold-tier member");
Check(new Customers.LoyaltyService().DiscountRate(Customers.LoyaltyTier.Gold) == 0.10m, "LoyaltyService.DiscountRate(Gold) == 0.10");
Check(new Customers.LoyaltyService().DiscountRate(Customers.LoyaltyTier.Silver) == 0.05m, "LoyaltyService.DiscountRate(Silver) == 0.05");

// --- Ordering: factory, command, derived total with bulk discount ---------------
Console.WriteLine("\nOrdering");
var order = Samples.BuildOrder();
// Documented total: 3 * 9.99 + (12 * 2.00) * 0.9  =  29.97 + 21.60  =  51.57
var expectedTotal = 3 * 9.99m + 12 * 2.00m * 0.9m;
Check(order.Total.Amount == expectedTotal, $"order.Total == {expectedTotal} (3*9.99 + 12*2.00*0.9 — 10% bulk discount on the 12-unit line)");
Check(order.LineCount == 2, "order.LineCount == 2");
Check(order.IsPlaced, "order.IsPlaced (submittedAt.isPresent after Submit)");
Check(order.Status == Ordering.OrderStatus.Submitted, "order.Status == Submitted");
Check(order.DomainEvents.Count == 2, "order raised OrderOpened + OrderSubmitted");
Throws<DomainInvariantViolationException>(() => order.Submit(), "submitting an already-submitted order is rejected");

// --- Shipping: module aggregate, imported value object, state machine ------------
Console.WriteLine("\nShipping");
var shipment = Samples.BuildShipment();
Check(shipment.Status == Shipping.ShipmentStatus.Dispatched, "shipment.Status == Dispatched after Dispatch()");
Throws<DomainInvariantViolationException>(() => shipment.Dispatch(), "dispatching an already-dispatched shipment is rejected");

// --- Payments: factory, command, ledger ----------------------------------------
Console.WriteLine("\nPayments");
var payment = Samples.BuildPayment();
Check(payment.Status == Payments.PaymentStatus.Captured, "payment.Status == Captured after Capture()");
Throws<DomainInvariantViolationException>(() => payment.Capture(), "capturing an already-captured payment is rejected");

// --- Consumer seams: repositories, services, query handlers, subscribers --------
await Consumers.RunAsync();

Console.WriteLine("\nAll demo assertions passed.");
