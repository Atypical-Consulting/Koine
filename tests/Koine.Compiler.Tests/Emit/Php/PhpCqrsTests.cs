using Koine.Compiler.Emit;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// PHP emitter — application / CQRS slice (R12).
/// Verifies that <see cref="PhpEmitter"/> emits read models (R12.3) and
/// query-handler seams (R12.4) as idiomatic PHP 8.1 readonly classes/interfaces.
/// </summary>
public class PhpCqrsTests
{
    // -----------------------------------------------------------------------
    // Fixtures
    // -----------------------------------------------------------------------

    /// <summary>
    /// A full read/write fixture mirroring the C# R12 fixture, adapted for PHP tests.
    /// </summary>
    private const string ReadModelFixture = """
        context Sales {
          enum OrderStatus { Draft, Placed, Shipped }
          value OrderLine { product: ProductId  quantity: Int }
          aggregate Sales root Order {
            entity Order identified by OrderId {
              customer: CustomerId
              lines:    List<OrderLine>
              status:   OrderStatus = Draft
            }
          }

          readmodel OrderSummary from Order {
            id
            customer
            status
            lineCount: Int = lines.count
          }
        }
        """;

    private const string QueryFixture = """
        context Sales {
          enum OrderStatus { Draft, Placed, Shipped }
          value OrderLine { product: ProductId  quantity: Int }
          aggregate Sales root Order {
            entity Order identified by OrderId {
              customer: CustomerId
              lines:    List<OrderLine>
              status:   OrderStatus = Draft
            }
          }

          readmodel OrderSummary from Order {
            id
            customer
            status
            lineCount: Int = lines.count
          }

          query OrdersByStatus(status: OrderStatus): List<OrderSummary>
          query OrderById(id: OrderId): OrderSummary
        }
        """;

    /// <summary>
    /// A source whose member <c>doubled</c> is DERIVED (its initializer references the sibling
    /// <c>qty</c>), directly projected by a read model. The source VO emits <c>doubled</c> as a
    /// getter method, so the projection must CALL it (<c>$src-&gt;doubled()</c>) — a property read
    /// would hit an undefined property. (#615)
    /// </summary>
    private const string DerivedDirectProjectionFixture = """
        context Sales {
          value Order {
            qty:     Int
            doubled: Int = qty * 2
          }

          readmodel OrderView from Order {
            doubled
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
    // R12.3 — Read models
    // -----------------------------------------------------------------------

    [Fact]
    public void ReadModel_emits_readonly_dto_and_projection()
    {
        var files = Emit(ReadModelFixture);

        // File is emitted in the ReadModels/ subfolder
        files.ShouldContain(f => f.RelativePath == "src/Sales/ReadModels/OrderSummary.php");

        var content = FileContent(files, "src/Sales/ReadModels/OrderSummary.php");

        // PHP file header
        content.ShouldContain("<?php");
        content.ShouldContain("declare(strict_types=1)");
        content.ShouldContain("namespace Koine\\Sales\\ReadModels");

        // DTO is a final readonly class
        content.ShouldContain("final readonly class OrderSummary");

        // Direct fields appear in constructor
        content.ShouldContain("public OrderId $id");
        content.ShouldContain("public CustomerId $customer");
        content.ShouldContain("public OrderStatus $status");

        // Derived field (lineCount: Int = lines.count)
        content.ShouldContain("public int $lineCount");

        // Projection function present
        content.ShouldContain("function toOrderSummary(Order $src): OrderSummary");

        // Direct fields copy $src->field
        content.ShouldContain("$src->id");
        content.ShouldContain("$src->customer");
        content.ShouldContain("$src->status");

        // Derived field translates projection
        content.ShouldContain("count($src->lines)");
    }

    [Fact]
    public void ReadModel_file_has_strict_types_and_php_81_syntax()
    {
        var files = Emit(ReadModelFixture);
        var content = FileContent(files, "src/Sales/ReadModels/OrderSummary.php");

        // PHP 8.1 readonly constructor promotion
        content.ShouldContain("public function __construct(");
        content.ShouldContain("declare(strict_types=1)");
    }

    [Fact]
    public void ReadModel_imports_source_type_via_use()
    {
        var files = Emit(ReadModelFixture);
        var content = FileContent(files, "src/Sales/ReadModels/OrderSummary.php");

        // The source entity (Order) is in Entities/, so a `use` import is needed
        content.ShouldContain("use Koine\\Sales\\Entities\\Order");
    }

    // #615 — a read model that directly projects a DERIVED source member must CALL the getter
    // method ($src->doubled()), not read it as an undefined property ($src->doubled), matching how
    // the source VO/entity emits a computed member. A property read is null under strict_types and
    // fails phpstan --level max.
    [Fact]
    public void ReadModel_direct_projection_of_derived_member_emits_getter_call()
    {
        var files = Emit(DerivedDirectProjectionFixture);
        var content = FileContent(files, "src/Sales/ReadModels/OrderView.php");

        // The projection function CALLS the derived getter rather than reading a bare property.
        content.ShouldContain("function toOrderView(Order $src): OrderView");
        content.ShouldContain("$src->doubled()");
        content.ShouldNotContain("$src->doubled,");
    }

    // A directly-projected STORED member stays a plain property read — regression guard so the
    // #615 fix targets only derived members.
    [Fact]
    public void ReadModel_direct_projection_of_stored_member_stays_a_property_read()
    {
        var files = Emit(DerivedDirectProjectionFixture);
        var content = FileContent(files, "src/Sales/ReadModels/OrderView.php");

        // `doubled` is the only projected field, but its derived initializer references the stored
        // `qty`; the stored member itself is never called when referenced as a property.
        content.ShouldNotContain("$src->qty()");
    }

    [Fact]
    public Task ReadModel_direct_derived_projection_snapshot()
    {
        var files = Emit(DerivedDirectProjectionFixture);
        var readModel = FileContent(files, "src/Sales/ReadModels/OrderView.php");
        return Verify(readModel);
    }

    // -----------------------------------------------------------------------
    // R12.4 — Queries
    // -----------------------------------------------------------------------

    [Fact]
    public void Query_emits_criteria_dto_and_handler_seam()
    {
        var files = Emit(QueryFixture);

        // Both queries get files
        files.ShouldContain(f => f.RelativePath == "src/Sales/Queries/OrdersByStatus.php");
        files.ShouldContain(f => f.RelativePath == "src/Sales/Queries/OrderById.php");

        var listQuery = FileContent(files, "src/Sales/Queries/OrdersByStatus.php");
        var singleQuery = FileContent(files, "src/Sales/Queries/OrderById.php");

        // File header
        listQuery.ShouldContain("<?php");
        listQuery.ShouldContain("declare(strict_types=1)");
        listQuery.ShouldContain("namespace Koine\\Sales\\Queries");

        // Criteria DTO is a final readonly class
        listQuery.ShouldContain("final readonly class OrdersByStatus");
        singleQuery.ShouldContain("final readonly class OrderById");

        // Criteria parameters appear in constructor
        listQuery.ShouldContain("public OrderStatus $status");
        singleQuery.ShouldContain("public OrderId $id");

        // Handler interface seam
        listQuery.ShouldContain("interface OrdersByStatusHandler");
        singleQuery.ShouldContain("interface OrderByIdHandler");
    }

    [Fact]
    public void Query_handler_seam_extends_query_handler_interface()
    {
        var files = Emit(QueryFixture);
        var content = FileContent(files, "src/Sales/Queries/OrdersByStatus.php");

        // The handler seam should extend or reference QueryHandler
        content.ShouldContain("QueryHandler");
    }

    [Fact]
    public void Query_without_criteria_emits_empty_dto()
    {
        const string src = """
            context C {
              value V { x: Int }
              readmodel VM from V { x }
              query AllV(): List<VM>
            }
            """;
        var files = Emit(src);
        files.ShouldContain(f => f.RelativePath == "src/C/Queries/AllV.php");
        var content = FileContent(files, "src/C/Queries/AllV.php");
        content.ShouldContain("final readonly class AllV");
        content.ShouldContain("interface AllVHandler");
    }

    // -----------------------------------------------------------------------
    // Verify snapshot (determinism check)
    // -----------------------------------------------------------------------

    [Fact]
    public Task ReadModel_and_Query_snapshot()
    {
        var files = Emit(QueryFixture);
        var readModel = FileContent(files, "src/Sales/ReadModels/OrderSummary.php");
        var listQuery = FileContent(files, "src/Sales/Queries/OrdersByStatus.php");
        var singleQuery = FileContent(files, "src/Sales/Queries/OrderById.php");

        return Verify(new { ReadModel = readModel, ListQuery = listQuery, SingleQuery = singleQuery });
    }
}
