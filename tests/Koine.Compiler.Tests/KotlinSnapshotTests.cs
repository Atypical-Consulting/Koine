using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Snapshot coverage for the Kotlin backend (issue #1066): each fixture is snapshot-tested (the diff is the
/// review of the generated Kotlin) and the shape-defining lines are pinned with <c>ShouldContain</c>. The
/// real-<c>kotlinc</c> conformance that proves the emitted tree type-checks lives in
/// <see cref="Conformance.KotlinConformanceTests"/> (Task 9); these tests lock the emitted <em>shape</em>.
/// Grows one fixture family per construct task (value objects + IDs → enums → entities → messages).
/// </summary>
public class KotlinSnapshotTests
{
    // Value objects only (no enum/entity), so the snapshot is stable across the later construct tasks:
    // a data class with an init-block invariant, a computed derived property, a regex invariant, and the
    // runtime Range<T> interval type.
    private const string ValueObjectFixture = """
        context Catalog {
          /// A stock-keeping unit, shape-validated and normalized.
          value Sku {
            code:       String
            normalized: String = code.trim.upper
            invariant code.trim.length > 0                "a SKU cannot be blank"
            invariant code matches /^[A-Z]{3}-[0-9]{4}$/  "SKU must look like ABC-1234"
          }

          /// A monetary amount. Never negative.
          value Money {
            amount: Decimal
            invariant amount >= 0 "a monetary amount cannot be negative"
          }

          /// A sale window over an instant interval.
          value SalePeriod {
            window: Range<Instant>
          }
        }
        """;

    [Fact]
    public Task Kotlin_value_objects_emit_expected_kotlin()
    {
        var result = new KoineCompiler().Compile(ValueObjectFixture, new KotlinEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var sku = result.Files.Single(f => f.RelativePath.EndsWith("Sku.kt", StringComparison.Ordinal)).Contents;
        sku.ShouldContain("data class Sku(");
        sku.ShouldContain("val normalized: String get() = this.code.trim().uppercase()");
        sku.ShouldContain("init {");
        sku.ShouldContain("throw koine.runtime.DomainException(\"a SKU cannot be blank\")");
        // Invariants translate in Parameter mode (bare property names, inside the init block); the `$`
        // end-anchor is escaped in the Kotlin string; matching is unanchored (containsMatchIn).
        sku.ShouldContain("Regex(\"^[A-Z]{3}-[0-9]{4}\\$\").containsMatchIn(code)");

        var money = result.Files.Single(f => f.RelativePath.EndsWith("Money.kt", StringComparison.Ordinal)).Contents;
        money.ShouldContain("val amount: java.math.BigDecimal");
        money.ShouldContain("if (!(amount.compareTo(java.math.BigDecimal.ZERO) >= 0)) throw koine.runtime.DomainException");

        var period = result.Files.Single(f => f.RelativePath.EndsWith("SalePeriod.kt", StringComparison.Ordinal)).Contents;
        period.ShouldContain("val window: koine.runtime.Range<java.time.Instant>");

        return Verify(TestSupport.Render(result.Files)).UseDirectory("Snapshots");
    }

    // A plain value object scaled by an Int — Money gets a demand-driven `operator fun times(factor: Long)`,
    // and Line's derived member lowers `unitPrice * quantity` to `unitPrice.times(quantity)`. No enum/entity,
    // so the snapshot is stable.
    private const string ScalarOpFixture = """
        context Shop {
          value Money {
            amount: Decimal
            invariant amount >= 0 "an amount cannot be negative"
          }
          value Line {
            unitPrice: Money
            quantity:  Int
            subtotal:  Money = unitPrice * quantity
          }
        }
        """;

    [Fact]
    public Task Kotlin_scalar_operator_emits_expected_kotlin()
    {
        var result = new KoineCompiler().Compile(ScalarOpFixture, new KotlinEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var money = result.Files.Single(f => f.RelativePath.EndsWith("Money.kt", StringComparison.Ordinal)).Contents;
        // Demand-driven scalar multiply: an Int factor -> a Long overload multiplying the Decimal field.
        money.ShouldContain("operator fun times(factor: Long): Money = Money(this.amount.multiply(java.math.BigDecimal.valueOf(factor)))");

        var line = result.Files.Single(f => f.RelativePath.EndsWith("Line.kt", StringComparison.Ordinal)).Contents;
        line.ShouldContain("val subtotal: Money get() = this.unitPrice.times(this.quantity)");

        return Verify(TestSupport.Render(result.Files)).UseDirectory("Snapshots");
    }

    // A quantity: unit-checked plus/minus and a scalar scale. Uses an enum for the unit, so the emitted-output
    // shape is pinned with ShouldContain (the enum file is added by the enum task) rather than a full snapshot.
    private const string QuantityFixture = """
        context Q {
          enum MassUnit { Gram, Kilogram }
          quantity Weight {
            amount: Decimal
            unit:   MassUnit
            invariant amount >= 0 "a weight cannot be negative"
          }
        }
        """;

    [Fact]
    public void Kotlin_quantity_emits_unit_checked_operators()
    {
        var result = new KoineCompiler().Compile(QuantityFixture, new KotlinEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var weight = result.Files.Single(f => f.RelativePath.EndsWith("Weight.kt", StringComparison.Ordinal)).Contents;
        weight.ShouldContain("data class Weight(");
        weight.ShouldContain("operator fun plus(other: Weight): Weight {");
        weight.ShouldContain("if (this.unit != other.unit) throw koine.runtime.DomainException(");
        weight.ShouldContain("return Weight(this.amount.add(other.amount), this.unit)");
        weight.ShouldContain("operator fun minus(other: Weight): Weight {");
        weight.ShouldContain("fun scale(factor: java.math.BigDecimal): Weight = Weight(this.amount.multiply(factor), this.unit)");
    }

    // Regression (code-review): a quantity scaled by a scalar (`w * 2`) is lowered by the translator to
    // `w.times(2L)`, so the quantity must ALSO emit the demand-driven `times`/`div` operators — not only
    // its unit-checked plus/minus/scale (else `kotlinc` reports 'unresolved reference: times').
    private const string ScaledQuantityFixture = """
        context Q {
          enum MassUnit { Gram, Kilogram }
          quantity Weight {
            amount: Decimal
            unit:   MassUnit
            invariant amount >= 0 "a weight cannot be negative"
          }
          value Bag {
            net:     Weight
            doubled: Weight = net * 2
          }
        }
        """;

    [Fact]
    public void Kotlin_scaled_quantity_emits_the_times_operator()
    {
        var result = new KoineCompiler().Compile(ScaledQuantityFixture, new KotlinEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var weight = result.Files.Single(f => f.RelativePath.EndsWith("Weight.kt", StringComparison.Ordinal)).Contents;
        // The scaled quantity gets a demand-driven `times(Long)` (in addition to its unit-checked plus/minus).
        weight.ShouldContain("operator fun times(factor: Long): Weight = Weight(this.amount.multiply(java.math.BigDecimal.valueOf(factor)), this.unit)");

        var bag = result.Files.Single(f => f.RelativePath.EndsWith("Bag.kt", StringComparison.Ordinal)).Contents;
        bag.ShouldContain("val doubled: Weight get() = this.net.times(2L)");
    }

    // Generated identity types: a UUID-backed id (with generate()), a natural String key (blank-checked), and
    // a sequence Long key. Only the id files are asserted (the entity class bodies are the entity task), so
    // this stays green when the entity task lands.
    private const string IdFixture = """
        context Ids {
          entity Guid identified by GuidId { note: String }
          entity Nat  identified by NatId as natural(String) { note: String }
          entity Seq  identified by SeqId as sequence { note: String }
        }
        """;

    [Fact]
    public void Kotlin_generated_ids_emit_value_classes()
    {
        var result = new KoineCompiler().Compile(IdFixture, new KotlinEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var guid = result.Files.Single(f => f.RelativePath.EndsWith("GuidId.kt", StringComparison.Ordinal)).Contents;
        guid.ShouldContain("@JvmInline");
        guid.ShouldContain("value class GuidId(val value: java.util.UUID)");
        guid.ShouldContain("fun generate(): GuidId = GuidId(java.util.UUID.randomUUID())");

        var nat = result.Files.Single(f => f.RelativePath.EndsWith("NatId.kt", StringComparison.Ordinal)).Contents;
        nat.ShouldContain("value class NatId(val value: String)");
        nat.ShouldContain("if (value.isBlank()) throw koine.runtime.DomainException(\"identity value cannot be blank\")");

        var seq = result.Files.Single(f => f.RelativePath.EndsWith("SeqId.kt", StringComparison.Ordinal)).Contents;
        seq.ShouldContain("value class SeqId(val value: Long)");
        seq.ShouldNotContain("generate()");
    }

    // Smart enums: a data-carrying enum (constructor `val`s are the accessors) and a bare enum, each with the
    // neutral-key companion. Enums only, so the snapshot is stable.
    private const string EnumFixture = """
        context Enums {
          /// Currencies, carrying their symbol and minor-unit count.
          enum Currency(symbol: String, decimals: Int) {
            EUR("€", 2)
            USD("$", 2)
            GBP("£", 2)
          }

          enum OrderStatus { Draft, Placed, Shipped, Cancelled }
        }
        """;

    [Fact]
    public Task Kotlin_smart_enums_emit_expected_kotlin()
    {
        var result = new KoineCompiler().Compile(EnumFixture, new KotlinEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var currency = result.Files.Single(f => f.RelativePath.EndsWith("Currency.kt", StringComparison.Ordinal)).Contents;
        // Associated data becomes primary-constructor `val`s (the accessors); Int -> Long, so `2` -> `2L`.
        currency.ShouldContain("enum class Currency(val symbol: String, val decimals: Long) {");
        currency.ShouldContain("EUR(\"€\", 2L),");
        currency.ShouldContain("GBP(\"£\", 2L);");
        currency.ShouldContain("fun tryFromKey(key: String): Currency? = entries.find { it.name == key }");
        currency.ShouldContain("fun fromKey(key: String): Currency = tryFromKey(key) ?: throw koine.runtime.DomainException(\"no Currency with key '$key'\")");

        var status = result.Files.Single(f => f.RelativePath.EndsWith("OrderStatus.kt", StringComparison.Ordinal)).Contents;
        status.ShouldContain("enum class OrderStatus {");
        status.ShouldContain("Draft,");
        status.ShouldContain("Cancelled;");
        status.ShouldContain("companion object {");

        return Verify(TestSupport.Render(result.Files)).UseDirectory("Snapshots");
    }

    [Fact]
    public void Kotlin_enum_member_named_like_a_keyword_is_backtick_escaped()
    {
        var result = new KoineCompiler().Compile(
            "context Kw { enum Access { object, normal } }", new KotlinEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var access = result.Files.Single(f => f.RelativePath.EndsWith("Access.kt", StringComparison.Ordinal)).Contents;
        access.ShouldContain("`object`,");   // a Kotlin hard keyword — backtick-escaped
        access.ShouldContain("normal;");     // not a keyword — verbatim
    }

    // A plain data entity: identity + a validated member + a derived member, identity equality — no enum,
    // behaviors, or events, so the snapshot is stable.
    private const string EntityFixture = """
        context People {
          /// A customer, identified and validated.
          entity Customer identified by CustomerId {
            name:        String
            displayName: String = name.trim
            invariant name.trim.length > 0 "a customer needs a name"
          }
        }
        """;

    [Fact]
    public Task Kotlin_entity_emits_expected_kotlin()
    {
        var result = new KoineCompiler().Compile(EntityFixture, new KotlinEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var customer = result.Files.Single(f => f.RelativePath.EndsWith("Customer.kt", StringComparison.Ordinal)).Contents;
        customer.ShouldContain("class Customer(");
        customer.ShouldContain("val id: CustomerId = id");
        customer.ShouldContain("val name: String = name");
        customer.ShouldContain("init {");
        customer.ShouldContain("private fun checkInvariants() {");
        customer.ShouldContain("if (!(this.name.trim().length.toLong() > 0L)) throw koine.runtime.DomainException(\"a customer needs a name\")");
        customer.ShouldContain("val displayName: String get() = this.name.trim()");
        customer.ShouldContain("override fun equals(other: Any?): Boolean =");
        customer.ShouldContain("this === other || (other is Customer && this.id == other.id)");
        customer.ShouldContain("override fun hashCode(): Int = this.id.hashCode()");

        return Verify(TestSupport.Render(result.Files)).UseDirectory("Snapshots");
    }

    // An entity with guarded behaviors: read-only-outside mutable state (`var … private set`), preconditions,
    // a transition, invariant re-check, and a recorded domain event. Uses an enum + event, so pinned with
    // ShouldContain (the DomainEvent/event files are the messages task).
    private const string BehaviorFixture = """
        context Shop {
          enum Status { Active, Suspended }
          event Deposited { accountId: AccountId  amount: Int }
          entity Account identified by AccountId {
            balance: Int
            status:  Status = Active
            healthy: Bool = balance >= 0
            invariant balance >= 0 "balance cannot go negative"
            command deposit(amount: Int) {
              requires status == Active "account must be active"
              requires amount > 0 "deposit must be positive"
              balance -> balance + amount
              emit Deposited(accountId: id, amount: amount)
            }
            command suspend {
              status -> Suspended
            }
          }
        }
        """;

    [Fact]
    public void Kotlin_entity_behaviors_guard_mutate_and_record_events()
    {
        var result = new KoineCompiler().Compile(BehaviorFixture, new KotlinEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var account = result.Files.Single(f => f.RelativePath.EndsWith("Account.kt", StringComparison.Ordinal)).Contents;
        // Mutable state is read-only from outside (var … private set); a derived Bool member.
        account.ShouldContain("var balance: Long = balance");
        account.ShouldContain("private set");
        account.ShouldContain("var status: Status = Status.Active");
        account.ShouldContain("val healthy: Boolean get() = this.balance >= 0L");
        account.ShouldContain("private val _domainEvents: MutableList<DomainEvent> = mutableListOf()");
        // A behavior: preconditions -> transition -> invariant re-check -> recorded event.
        account.ShouldContain("fun deposit(amount: Long) {");
        account.ShouldContain("if (!(this.status == Status.Active)) throw koine.runtime.DomainException(\"account must be active\")");
        account.ShouldContain("this.balance = this.balance + amount");
        account.ShouldContain("checkInvariants()");
        account.ShouldContain("this._domainEvents.add(Deposited(this.id, amount))");
        account.ShouldContain("fun suspend() {");
        account.ShouldContain("this.status = Status.Suspended");
        account.ShouldContain("fun domainEvents(): List<DomainEvent> = this._domainEvents.toList()");
    }

    // A factory on an aggregate root: mints a UUID identity, checks a precondition, constructs, records a
    // creation event, and returns the instance.
    private const string FactoryFixture = """
        context Sales {
          event OrderOpened { orderId: OrderId  lineCount: Int }
          aggregate Sales root Order {
            entity Order identified by OrderId {
              lines: Int
              create open(lines: Int) {
                requires lines >= 1 "an order needs at least one line"
                emit OrderOpened(orderId: id, lineCount: lines)
              }
            }
          }
        }
        """;

    [Fact]
    public void Kotlin_factory_mints_identity_and_records_creation_event()
    {
        var result = new KoineCompiler().Compile(FactoryFixture, new KotlinEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var order = result.Files.Single(f => f.RelativePath.EndsWith("Order.kt", StringComparison.Ordinal)).Contents;
        order.ShouldContain("companion object {");
        order.ShouldContain("fun open(lines: Long): Order {");
        order.ShouldContain("val id: OrderId = OrderId.generate()");
        order.ShouldContain("if (!(lines >= 1L)) throw koine.runtime.DomainException(\"an order needs at least one line\")");
        order.ShouldContain("val instance = Order(id, lines)");
        order.ShouldContain("instance._domainEvents.add(OrderOpened(id, lines))");
        order.ShouldContain("return instance");
    }

    // Events (domain + integration) as data classes under a sealed DomainEvent, a repository with tuned
    // operations + finders, and an unowned foreign identity (CustomerId, referenced but not owned here).
    private const string MessagesFixture = """
        context Sales {
          value Money {
            amount: Decimal
            invariant amount >= 0 "an amount cannot be negative"
          }
          event OrderPlaced { orderId: OrderId  total: Money }
          integration event OrderShipped { orderId: OrderId }
          aggregate Sales root Order {
            entity Order identified by OrderId {
              customer: CustomerId
            }
            repository {
              operations: getById, add, update
              find byCustomer(customer: CustomerId): List<Order>
              find mostRecent(customer: CustomerId): Order
            }
          }
        }
        """;

    [Fact]
    public Task Kotlin_events_and_repository_emit_expected_kotlin()
    {
        var result = new KoineCompiler().Compile(MessagesFixture, new KotlinEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var placed = result.Files.Single(f => f.RelativePath.EndsWith("OrderPlaced.kt", StringComparison.Ordinal)).Contents;
        placed.ShouldContain("data class OrderPlaced(");
        placed.ShouldContain(") : DomainEvent");

        var domainEvent = result.Files.Single(f => f.RelativePath.EndsWith("DomainEvent.kt", StringComparison.Ordinal)).Contents;
        domainEvent.ShouldContain("sealed interface DomainEvent");

        var repo = result.Files.Single(f => f.RelativePath.EndsWith("OrderRepository.kt", StringComparison.Ordinal)).Contents;
        repo.ShouldContain("interface OrderRepository {");
        repo.ShouldContain("fun getById(id: OrderId): Order?");
        repo.ShouldContain("fun add(aggregate: Order)");
        repo.ShouldContain("fun byCustomer(customer: CustomerId): List<Order>");
        repo.ShouldContain("fun mostRecent(customer: CustomerId): Order?");
        repo.ShouldNotContain("fun remove(");   // `operations` excludes remove

        // CustomerId is referenced by Order but owned by no local entity — materialized as a minimal brand.
        var customerId = result.Files.Single(f => f.RelativePath.EndsWith("CustomerId.kt", StringComparison.Ordinal)).Contents;
        customerId.ShouldContain("value class CustomerId(val value: java.util.UUID)");

        return Verify(TestSupport.Render(result.Files)).UseDirectory("Snapshots");
    }

    // End-to-end: the real billing starter template — value objects, a smart enum, entities, an aggregate with
    // a nested enum/value/entity, a demand-driven scalar-Mul member, a `when`-guarded invariant, the default
    // repository interface, and the unowned ProductId brand.
    [Fact]
    public Task Kotlin_billing_template_emits_expected_kotlin()
    {
        var result = new KoineCompiler().Compile(TestSupport.BillingFixture, new KotlinEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var repo = result.Files.Single(f => f.RelativePath.EndsWith("OrderRepository.kt", StringComparison.Ordinal)).Contents;
        repo.ShouldContain("interface OrderRepository {");
        repo.ShouldContain("fun getById(id: OrderId): Order?");
        repo.ShouldContain("fun remove(id: OrderId)");   // default ops include remove

        var money = result.Files.Single(f => f.RelativePath.EndsWith("Money.kt", StringComparison.Ordinal)).Contents;
        money.ShouldContain("operator fun times(factor: Long): Money");   // demand-driven scalar op

        var productId = result.Files.Single(f => f.RelativePath.EndsWith("ProductId.kt", StringComparison.Ordinal)).Contents;
        productId.ShouldContain("value class ProductId(");   // unowned id materialized

        return Verify(TestSupport.Render(result.Files)).UseDirectory("Snapshots");
    }
}
