using Koine.Compiler.Services;

namespace Koine.Compiler.Tests.Conformance;

/// <summary>
/// Snapshot + <c>javac</c> coverage for the Java backend (issue #858), the Java analogue of
/// <see cref="RustSnapshotTests"/>. Each fixture is snapshot-tested (the diff is the review of the
/// generated Java) AND compiled with <see cref="TestSupport.CompileJava"/> when a JDK 17+ toolchain is
/// present — so a green build proves the emitted sources compile. The emitted code targets Java 17
/// (records, sealed types); when no JDK 17+ is present the compile is funneled through
/// <see cref="TestSupport.RequireOrSkip"/>, which reports the test as <c>Skipped</c> (not a false Passed)
/// — and a hard <c>Failed</c> in CI, where <c>KOINE_REQUIRE_CONFORMANCE</c> is set and a JDK 17+
/// installed. The snapshot tests themselves need no JDK: they lock the emitted strings and run for real
/// everywhere.
/// </summary>
public class JavaSnapshotTests
{
    private const string NoToolchainNotice =
        "No usable JDK 17+ toolchain (javac >= 17) available; javac not run.";

    /// <summary>Value objects with invariants (a <c>BigDecimal</c> guard + a regex <c>matches</c> guard) and a smart enum with associated data.</summary>
    private const string ValueObjectFixture = """
        context Billing {
          /// A monetary amount in a currency. Never negative.
          value Money {
            amount:   Decimal
            currency: Currency
            invariant amount >= 0 "a monetary amount cannot be negative"
          }

          /// Currencies with their ISO code and minor-unit count.
          enum Currency(code: String, decimals: Int) {
            EUR("EUR", 2)
            USD("USD", 2)
          }

          /// An email address, shape-validated.
          value Email {
            raw: String
            invariant raw matches /^[^@]+@[^@]+$/ "invalid email address"
          }
        }
        """;

    [Fact]
    public Task Java_value_objects_emit_expected_java()
    {
        var result = new KoineCompiler().Compile(ValueObjectFixture, new JavaEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        // The value objects are records with validating compact constructors; the failing-invariant path
        // is reachable and the Decimal guard compares via compareTo (never `>=` on BigDecimal directly).
        var money = result.Files.Single(f => f.RelativePath.EndsWith("Money.java", StringComparison.Ordinal)).Contents;
        money.ShouldContain("public record Money(java.math.BigDecimal amount, Currency currency)");
        money.ShouldContain("if (!(amount.compareTo(java.math.BigDecimal.ZERO) >= 0)) {");
        money.ShouldContain("throw new koine.runtime.DomainException(\"a monetary amount cannot be negative\");");

        return Verify(TestSupport.Render(result.Files)).UseDirectory("Snapshots");
    }

    [Fact]
    public void Java_value_objects_compile()
    {
        var result = new KoineCompiler().Compile(ValueObjectFixture, new JavaEmitter());
        result.Success.ShouldBeTrue();

        var check = TestSupport.CompileJava(result.Files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, NoToolchainNotice);

        check.Ok.ShouldBeTrue(string.Join("\n", check.Errors));
    }

    /// <summary>
    /// An aggregate that exercises the entity/event/repository core: an entity with a branded identity,
    /// an optional field, and an invariant-guarded behavior that raises a domain event; the event as a
    /// record implementing the per-context sealed <c>DomainEvent</c> interface; a foreign identity
    /// materialized as a branded record; and the aggregate-root repository interface.
    /// </summary>
    private const string EntityEventFixture = """
        context Billing {
          aggregate Invoicing root Invoice {
            repository {
              operations: getById, add, update
              find byCustomer(customer: CustomerId): List<Invoice>
            }

            event InvoiceIssued {
              invoiceId: InvoiceId
              total:     Decimal
            }

            enum InvoiceStatus { Draft, Issued, Paid }

            entity Invoice identified by InvoiceId {
              total:  Decimal
              status: InvoiceStatus = Draft
              note:   String?
              command issue {
                requires status == Draft "only a draft invoice can be issued"
                status -> Issued
                emit InvoiceIssued(invoiceId: id, total: total)
              }
            }
          }
        }
        """;

    [Fact]
    public Task Java_entities_and_events_emit_expected_java()
    {
        var result = new KoineCompiler().Compile(EntityEventFixture, new JavaEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        // Identity-equality entity class with an invariant-guarded behavior that records the event.
        var invoice = result.Files.Single(f => f.RelativePath.EndsWith("Invoice.java", StringComparison.Ordinal)).Contents;
        invoice.ShouldContain("public final class Invoice {");
        invoice.ShouldContain("public void issue() {");
        invoice.ShouldContain("this.domainEvents.add(new InvoiceIssued(this.id, this.total));");

        // The event is a record implementing the sealed DomainEvent, whose `permits` names it.
        var domainEvent = result.Files.Single(f => f.RelativePath.EndsWith("DomainEvent.java", StringComparison.Ordinal)).Contents;
        domainEvent.ShouldContain("public sealed interface DomainEvent permits InvoiceIssued {}");

        return Verify(TestSupport.Render(result.Files)).UseDirectory("Snapshots");
    }

    [Fact]
    public void Java_entities_and_events_compile()
    {
        var result = new KoineCompiler().Compile(EntityEventFixture, new JavaEmitter());
        result.Success.ShouldBeTrue();

        var check = TestSupport.CompileJava(result.Files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, NoToolchainNotice);

        check.Ok.ShouldBeTrue(string.Join("\n", check.Errors));
    }

    /// <summary>
    /// Phase 2 (issue #1090, Task 1) — the application/CQRS layer: a <c>service</c> with use cases, a
    /// <c>readmodel</c> with direct and derived fields (so the projection has real behavior), and a
    /// <c>query</c>. The snapshot is the review of the emitted application interface, the read-model
    /// record + its static <c>from</c> projection, and the query record + its <c>QueryHandler</c> seam.
    /// Shares <see cref="JavaCqrsTests.Fixture"/> so the string assertions there and this reviewed
    /// snapshot can never drift apart.
    /// </summary>
    [Fact]
    public Task Java_cqrs_fixture_emits_expected_java()
    {
        var result = new KoineCompiler().Compile(JavaCqrsTests.Fixture, new JavaEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        return Verify(TestSupport.Render(result.Files)).UseDirectory("Snapshots");
    }

    /// <summary>
    /// The CQRS emit must be real Java: the record + static projection, the
    /// <c>CompletableFuture</c>-returning service boundary, and the <c>QueryHandler</c> specialization all
    /// have to type-check against a real <c>javac --release 17</c> — a string/snapshot assertion alone
    /// cannot see, say, a generic argument left as an unboxable primitive.
    /// </summary>
    [Fact]
    public void Java_cqrs_fixture_compiles()
    {
        var result = new KoineCompiler().Compile(JavaCqrsTests.Fixture, new JavaEmitter());
        result.Success.ShouldBeTrue();

        var check = TestSupport.CompileJava(result.Files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, NoToolchainNotice);

        check.Ok.ShouldBeTrue(string.Join("\n", check.Errors));
    }

    /// <summary>
    /// Phase 2 (issue #1090, Task 2) — a cross-aggregate <c>policy</c>: the reviewed snapshot locks the
    /// emitted <c>&lt;Name&gt;Policy</c> reactor interface and, crucially, the reaction sketch that
    /// translates the triggering event's fields into the target command's named arguments.
    /// </summary>
    [Fact]
    public Task Java_policy_fixture_emits_expected_java()
    {
        var result = new KoineCompiler().Compile(JavaPoliciesTests.Fixture, new JavaEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        return Verify(TestSupport.Render(result.Files)).UseDirectory("Snapshots");
    }

    /// <summary>
    /// The policy emit must be real Java — in particular the Javadoc sketch, which interpolates a
    /// translated expression and so is the one place an emitted comment could be malformed enough to
    /// break the parse.
    /// </summary>
    [Fact]
    public void Java_policy_fixture_compiles()
    {
        var result = new KoineCompiler().Compile(JavaPoliciesTests.Fixture, new JavaEmitter());
        result.Success.ShouldBeTrue();

        var check = TestSupport.CompileJava(result.Files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, NoToolchainNotice);

        check.Ok.ShouldBeTrue(string.Join("\n", check.Errors));
    }

    /// <summary>
    /// Phase 2 (issue #1090, Task 3) — an entity <c>states</c> machine: the reviewed snapshot locks the
    /// reachability guard preceding each governed transition (a multi-source target, a <c>when</c>-guarded
    /// rule, and the single-source guard suppressed because a <c>requires</c> already states it).
    /// </summary>
    [Fact]
    public Task Java_state_machine_fixture_emits_expected_java()
    {
        var result = new KoineCompiler().Compile(JavaBehaviorsTests.Fixture, new JavaEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        return Verify(TestSupport.Render(result.Files)).UseDirectory("Snapshots");
    }

    /// <summary>
    /// The reachability guards must be real Java: a <c>when</c> guard is a translated boolean expression
    /// spliced into an <c>if</c>, which is exactly the kind of shape a string assertion can accept and
    /// <c>javac</c> reject (an unboxed <c>Optional</c>, a missing paren, a non-boolean operand).
    /// </summary>
    [Fact]
    public void Java_state_machine_fixture_compiles()
    {
        var result = new KoineCompiler().Compile(JavaBehaviorsTests.Fixture, new JavaEmitter());
        result.Success.ShouldBeTrue();

        var check = TestSupport.CompileJava(result.Files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, NoToolchainNotice);

        check.Ok.ShouldBeTrue(string.Join("\n", check.Errors));
    }
}
