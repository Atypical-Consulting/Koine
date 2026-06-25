using Koine.Compiler.Emit;
using Koine.Compiler.Emit.Php;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// PHP emitter — application services + use cases + domain operations slice (R10.2 / R12.2).
/// Verifies that <see cref="PhpEmitter"/> emits service <c>interface</c>s (use cases) and
/// stateless domain-service <c>class</c>es (pure operations) as idiomatic PHP 8.1.
/// </summary>
public class PhpServicesTests
{
    // -----------------------------------------------------------------------
    // Fixtures
    // -----------------------------------------------------------------------

    /// <summary>
    /// A service with use cases only — maps to an application-service <c>interface</c>.
    /// </summary>
    private const string UseCaseFixture = """
        context Billing {
          value Money { amount: Decimal  currency: String }
          aggregate Billing root Invoice {
            entity Invoice identified by InvoiceId {
              total: Money
              isPaid: Bool = false
            }
          }

          service InvoiceService {
            usecase IssueInvoice(total: Money): InvoiceId
            usecase PayInvoice(id: InvoiceId)
          }
        }
        """;

    /// <summary>
    /// A service with pure operations — maps to a stateless domain-service class.
    /// Bodyless op = abstract seam (class becomes abstract).
    /// </summary>
    private const string OperationsFixture = """
        context Pricing {
          value Money { amount: Decimal  currency: String }

          service TaxCalculator {
            operation applyVat(amount: Decimal, rate: Decimal): Decimal = amount + amount * rate
            operation roundUp(amount: Decimal): Decimal
          }
        }
        """;

    /// <summary>
    /// A service with BOTH use cases and operations (combo fixture), plus a spec.
    /// </summary>
    private const string ComboFixture = """
        context Loans {
          enum LoanStatus { Active, Returned, Overdue }
          value Money { amount: Decimal  currency: String }
          aggregate Loans root Loan {
            entity Loan identified by LoanId {
              status: LoanStatus = Active
              amount: Money
            }
          }

          spec IsOverdue on Loan = status == Overdue

          service FinePolicy {
            operation fineFor(daysOverdue: Int, dailyRate: Int): Int =
              if daysOverdue > 0 then daysOverdue * dailyRate else 0
          }

          service LoanService {
            usecase BorrowItem(amount: Money): LoanId
            usecase ReturnItem(id: LoanId)
          }
        }
        """;

    private static IReadOnlyList<EmittedFile> Emit(string source)
    {
        var result = new KoineCompiler().Compile(source, new PhpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        return result.Files;
    }

    private static string FileContent(IReadOnlyList<EmittedFile> files, string path) =>
        files.Single(f => f.RelativePath == path).Contents;

    // -----------------------------------------------------------------------
    // R12.2 — Use cases → application-service interface
    // -----------------------------------------------------------------------

    [Fact]
    public void UseCases_emit_application_interface()
    {
        var files = Emit(UseCaseFixture);

        // File is emitted in the Services/ subfolder
        files.ShouldContain(f => f.RelativePath == "src/Billing/Services/InvoiceService.php");

        var content = FileContent(files, "src/Billing/Services/InvoiceService.php");

        // PHP file header
        content.ShouldContain("<?php");
        content.ShouldContain("declare(strict_types=1)");
        content.ShouldContain("namespace Koine\\Billing\\Services");

        // Application-service boundary = PHP interface
        content.ShouldContain("interface InvoiceService");

        // One method per use case
        content.ShouldContain("public function issueInvoice(");
        content.ShouldContain("public function payInvoice(");

        // ReturnType present: IssueInvoice → InvoiceId
        content.ShouldContain("): InvoiceId");

        // void use case (no ReturnType) → void
        content.ShouldContain("): void");

        // Parameters
        content.ShouldContain("Money $total");
        content.ShouldContain("InvoiceId $id");
    }

    [Fact]
    public void UseCases_interface_has_strict_types()
    {
        var files = Emit(UseCaseFixture);
        var content = FileContent(files, "src/Billing/Services/InvoiceService.php");

        content.ShouldContain("declare(strict_types=1)");
        content.ShouldContain("<?php");
    }

    // -----------------------------------------------------------------------
    // R10.2 — Operations → stateless domain-service class
    // -----------------------------------------------------------------------

    [Fact]
    public void Operations_emit_stateless_class()
    {
        var files = Emit(OperationsFixture);

        // File is emitted in the Services/ subfolder
        files.ShouldContain(f => f.RelativePath == "src/Pricing/Services/TaxCalculator.php");

        var content = FileContent(files, "src/Pricing/Services/TaxCalculator.php");

        // PHP file header
        content.ShouldContain("<?php");
        content.ShouldContain("declare(strict_types=1)");
        content.ShouldContain("namespace Koine\\Pricing\\Services");

        // Has a bodyless op → class is abstract
        content.ShouldContain("abstract class TaxCalculator");

        // Concrete op with expression body
        content.ShouldContain("public function applyVat(");

        // Bodyless op is abstract
        content.ShouldContain("abstract public function roundUp(");
    }

    [Fact]
    public void Operations_concrete_op_has_return_statement()
    {
        var files = Emit(OperationsFixture);
        var content = FileContent(files, "src/Pricing/Services/TaxCalculator.php");

        // The expression body of applyVat should be emitted as a return statement
        content.ShouldContain("return ");
    }

    [Fact]
    public void Operations_final_class_when_no_bodyless_op()
    {
        const string src = """
            context Calc {
              service Adder {
                operation add(a: Int, b: Int): Int = a + b
              }
            }
            """;
        var files = Emit(src);
        files.ShouldContain(f => f.RelativePath == "src/Calc/Services/Adder.php");
        var content = FileContent(files, "src/Calc/Services/Adder.php");

        // No bodyless op → final class
        content.ShouldContain("final class Adder");
        content.ShouldNotContain("abstract class Adder");
    }

    // -----------------------------------------------------------------------
    // R10.1 — Specifications → predicate class
    // -----------------------------------------------------------------------

    [Fact]
    public void Specifications_emit_predicate_class()
    {
        var files = Emit(ComboFixture);

        // Spec is emitted as a dedicated file
        files.ShouldContain(f => f.RelativePath == "src/Loans/Specifications/LoansSpecifications.php");

        var content = FileContent(files, "src/Loans/Specifications/LoansSpecifications.php");

        // PHP file header
        content.ShouldContain("<?php");
        content.ShouldContain("declare(strict_types=1)");
        content.ShouldContain("namespace Koine\\Loans\\Specifications");

        // Class or interface containing boolean predicates
        content.ShouldContain("isOverdue");
        content.ShouldContain("bool");
    }

    // -----------------------------------------------------------------------
    // Combo: both operations and use cases in one context
    // -----------------------------------------------------------------------

    [Fact]
    public void Combo_emits_both_domain_service_and_application_interface()
    {
        var files = Emit(ComboFixture);

        // Domain service (operations) file
        files.ShouldContain(f => f.RelativePath == "src/Loans/Services/FinePolicy.php");

        // Application service (use cases) file
        files.ShouldContain(f => f.RelativePath == "src/Loans/Services/LoanService.php");

        var domainSvc = FileContent(files, "src/Loans/Services/FinePolicy.php");
        var appSvc = FileContent(files, "src/Loans/Services/LoanService.php");

        // Domain service = class
        domainSvc.ShouldContain("class FinePolicy");
        domainSvc.ShouldContain("public function fineFor(");

        // Application service = interface
        appSvc.ShouldContain("interface LoanService");
        appSvc.ShouldContain("public function borrowItem(");
        appSvc.ShouldContain("public function returnItem(");
    }

    // -----------------------------------------------------------------------
    // Verify snapshot (determinism check)
    // -----------------------------------------------------------------------

    [Fact]
    public Task Services_snapshot()
    {
        var files = Emit(ComboFixture);
        var domainSvc = FileContent(files, "src/Loans/Services/FinePolicy.php");
        var appSvc = FileContent(files, "src/Loans/Services/LoanService.php");

        return Verify(new { DomainService = domainSvc, ApplicationService = appSvc });
    }
}
