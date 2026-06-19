using Koine.Compiler.Emit;
using Koine.Compiler.Emit.Python;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests.Conformance;

/// <summary>
/// Conformance harness for the Python backend. This exercises the
/// <see cref="TestSupport.TypeCheckPython"/> plumbing (write emitted <c>.py</c> → run
/// <c>mypy --strict</c>) plus the always-on <see cref="TestSupport.SyntaxCheckPython"/>
/// (<c>ast.parse</c> over every emitted module) so it is ready to validate the Python emitter as it
/// lands. When no <c>mypy</c>/Python toolchain is present locally the type-check is reported as
/// INCONCLUSIVE (a notice on the test output, no assertion) rather than failing — keeping
/// <c>dotnet test</c> green without a Python toolchain. It NEVER silently passes a real error: a real
/// error is only assertable when <c>mypy</c> is present, and then it IS asserted. CI is expected to
/// provide the toolchain and therefore actually run the check.
/// </summary>
/// <remarks>
/// Dynamic skip (<c>Assert.Skip</c>) is an xUnit v3 feature; on the v2 (2.9.x) runner here it is
/// reported as a failure, so an absent toolchain is surfaced as a logged inconclusive notice.
/// </remarks>
public class PythonConformanceTests
{
    private readonly ITestOutputHelper _output;

    public PythonConformanceTests(ITestOutputHelper output) => _output = output;

    private const string NoToolchainNotice =
        "INCONCLUSIVE: no Python toolchain (mypy) available locally; type-check not run. " +
        "Install mypy (or set KOINE_MYPY) — CI runs this for real.";

    private const string NoInterpreterNotice =
        "INCONCLUSIVE: no Python interpreter available locally; syntax check not run. " +
        "Install Python 3.11+ (or set KOINE_PYTHON) — CI runs this for real.";

    /// <summary>Clean, <c>--strict</c>-correct Python must type-check (inconclusive if no toolchain).</summary>
    [Fact]
    public void Harness_accepts_well_typed_python()
    {
        var files = new[]
        {
            new EmittedFile("ok.py", "def f(x: int) -> int:\n    return x\n"),
        };

        var r = TestSupport.TypeCheckPython(files);
        if (!r.ToolchainAvailable)
        {
            _output.WriteLine(NoToolchainNotice);
            return;
        }

        Assert.True(r.Ok, string.Join("\n", r.Errors));
    }

    /// <summary>
    /// A real <c>--strict</c> type error must be reported, not silently swallowed — this proves the
    /// harness is a genuine check (the analogue of the TypeScript negative fixture).
    /// </summary>
    [Fact]
    public void Harness_rejects_ill_typed_python()
    {
        var files = new[]
        {
            // Returns a str from a function annotated to return int → a real mypy --strict error.
            new EmittedFile("bad.py", "def f(x: int) -> int:\n    return \"nope\"\n"),
        };

        var r = TestSupport.TypeCheckPython(files);
        if (!r.ToolchainAvailable)
        {
            _output.WriteLine(NoToolchainNotice);
            return;
        }

        Assert.False(r.Ok);
        Assert.NotEmpty(r.Errors);
    }

    /// <summary>A missing toolchain yields an inconclusive-shaped result rather than a false pass.</summary>
    [Fact]
    public void Skipped_result_does_not_claim_success()
    {
        Assert.False(TestSupport.PythonCheck.Skipped.ToolchainAvailable);
        Assert.False(TestSupport.PythonCheck.Skipped.Ok);
        Assert.Empty(TestSupport.PythonCheck.Skipped.Errors);
    }

    /// <summary>
    /// The always-on syntax gate: a snippet using 3.11+ syntax (a <c>match</c> statement and a
    /// PEP&#160;604 <c>int | None</c> union) must parse via <c>ast.parse</c>. Inconclusive (logged,
    /// not failed) only when no interpreter is present; with one it MUST parse cleanly.
    /// </summary>
    [Fact]
    public void Syntax_check_parses_well_formed_python()
    {
        var files = new[]
        {
            new EmittedFile("syntax.py",
                "def classify(x: int | None) -> str:\n" +
                "    match x:\n" +
                "        case None:\n" +
                "            return \"none\"\n" +
                "        case _:\n" +
                "            return \"some\"\n"),
        };

        var r = TestSupport.SyntaxCheckPython(files);
        if (!r.ToolchainAvailable)
        {
            _output.WriteLine(NoInterpreterNotice);
            return;
        }

        Assert.True(r.Ok, string.Join("\n", r.Errors));
    }

    /// <summary>
    /// The Task-5 acceptance check: the Python the emitter actually produces for the shared Phase-1
    /// fixture must parse (<c>ast.parse</c>) and type-check cleanly under <c>mypy --strict</c>. In this
    /// task only the regular value objects emit (the quantity/enum/entity/event constructs land
    /// later), so the tree is the runtime + root files + value-object modules + their <c>__init__.py</c>s
    /// — and it must be dangling-import-free and strict-clean. Inconclusive (logged, not failed) only
    /// when no toolchain is present; with one it MUST pass with zero diagnostics.
    /// </summary>
    [Fact]
    public void Emitted_python_typechecks_under_strict()
    {
        var result = new KoineCompiler().Compile(PythonSnapshotTests.Fixture, new PythonEmitter());
        Assert.True(result.Success, string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        TestSupport.PythonCheck syntax = TestSupport.SyntaxCheckPython(result.Files);
        if (!syntax.ToolchainAvailable)
        {
            _output.WriteLine(NoInterpreterNotice);
        }
        else
        {
            Assert.True(syntax.Ok, "emitted Python should parse (ast.parse):\n" + string.Join("\n", syntax.Errors));
        }

        TestSupport.PythonCheck types = TestSupport.TypeCheckPython(result.Files);
        if (!types.ToolchainAvailable)
        {
            _output.WriteLine(NoToolchainNotice);
            return;
        }

        Assert.True(types.Ok, "emitted Python should type-check under mypy --strict:\n" + string.Join("\n", types.Errors));
    }

    /// <summary>
    /// A <c>versioned</c> aggregate plus its repository must emit and type-check under
    /// <c>mypy --strict</c>: the root carries a defaulted <c>version: int</c> field (legal dataclass
    /// ordering), is marked an <c>AggregateRoot</c>, and the repository is a <c>typing.Protocol</c>
    /// with async members. Proves Parts B and C.
    /// </summary>
    [Fact]
    public void Versioned_aggregate_and_repository_typecheck_under_strict()
    {
        const string source = """
            context Inventory {
              /// A stock item whose level is guarded by optimistic concurrency.
              aggregate Stock root Stock versioned {
                entity Stock identified by StockId {
                  sku:   String
                  level: Int = 0
                  invariant level >= 0 "stock level cannot be negative"
                }

                repository {
                  find bySku(sku: String): Stock
                }
              }

              /// A domain service computing a reorder signal (a pure operation).
              service ReorderPolicy {
                operation needsReorder(level: Int, threshold: Int): Bool = level < threshold
              }

              /// An application boundary for stock adjustments (async use cases).
              service StockAppService {
                usecase AdjustLevel(stock: StockId, delta: Int): StockId
                usecase Retire(stock: StockId)
              }
            }
            """;

        var result = new KoineCompiler().Compile(source, new PythonEmitter());
        Assert.True(result.Success, string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        // The versioned root carries `version` and is marked an AggregateRoot; the repository is an
        // async Protocol. Assert the emitted shapes regardless of toolchain availability.
        var root = FileText(result.Files, "inventory/stock.py");
        Assert.Contains("version: int = 0", root);
        Assert.Contains("_AGGREGATE_ROOT_CHECK: type[AggregateRoot] = Stock", root);

        var repo = FileText(result.Files, "inventory/repositories/stock_repository.py");
        Assert.Contains("class StockRepository(Protocol):", repo);
        Assert.Contains("async def get(self, id: StockId) -> Stock | None: ...", repo);
        Assert.Contains("async def save(self, aggregate: Stock) -> None: ...", repo);
        Assert.Contains("async def by_sku(self, sku: str) -> Stock | None: ...", repo);

        var domainService = FileText(result.Files, "inventory/reorder_policy.py");
        Assert.Contains("class ReorderPolicy(Protocol):", domainService);
        Assert.Contains("def needs_reorder(self, level: int, threshold: int) -> bool:", domainService);

        var appService = FileText(result.Files, "inventory/stock_app_service.py");
        Assert.Contains("class StockAppService(Protocol):", appService);
        Assert.Contains("async def adjust_level(self, stock: StockId, delta: int) -> StockId: ...", appService);
        Assert.Contains("async def retire(self, stock: StockId) -> None: ...", appService);

        AssertStrictlyTypeChecks(result.Files);
    }

    /// <summary>
    /// A two-context model where context <c>Sales</c> references a <c>value</c> from context
    /// <c>Catalog</c> must emit a QUALIFIED cross-context import to the type's real module
    /// (<c>from catalog.value_objects.sku import Sku</c>), never a guessed/relative path — both in the
    /// referencing value object AND in the aggregate-root repository Protocol. Proves Part D, which the
    /// single-context main fixture cannot exercise.
    /// </summary>
    [Fact]
    public void Cross_context_reference_resolves_to_qualified_import_and_typechecks()
    {
        const string source = """
            context Catalog {
              /// A stock-keeping unit identifying a catalog product.
              value Sku {
                code: String
                invariant code != "" "a sku code cannot be empty"
              }
            }

            context Sales {
              import Catalog.{ Sku }

              /// A line item referencing a catalog Sku from another bounded context.
              value BasketLine {
                sku:      Sku
                quantity: Int
                invariant quantity >= 1 "a line needs at least one unit"
              }

              aggregate Basket root Basket {
                entity Basket identified by BasketId {
                  lines: List<BasketLine>
                  invariant !lines.isEmpty "a basket must have at least one line"
                }

                repository {
                  find bySku(sku: Sku): List<Basket>
                }
              }
            }
            """;

        var result = new KoineCompiler().Compile(source, new PythonEmitter());
        Assert.True(result.Success, string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        // The cross-context `Sku` resolves to Catalog's real module — in the value object and the repo.
        var line = FileText(result.Files, "sales/value_objects/basket_line.py");
        Assert.Contains("from catalog.value_objects.sku import Sku", line);

        var repo = FileText(result.Files, "sales/repositories/basket_repository.py");
        Assert.Contains("from catalog.value_objects.sku import Sku", repo);
        Assert.Contains("async def by_sku(self, sku: Sku) -> tuple[Basket, ...]: ...", repo);

        // The root emits at the context package root (not under entities/).
        Assert.Contains(result.Files, f => f.RelativePath == "sales/basket.py");

        AssertStrictlyTypeChecks(result.Files);
    }

    /// <summary>
    /// Regression test for the ambiguous-enum-member-default bug: when two contexts both declare an
    /// enum with a shared member name (here <c>Pending</c>), a stored entity field whose declared type
    /// is the <em>second</em> enum (<c>ShipmentStatus</c>) and whose default value is that shared member
    /// must resolve to the <em>correct</em> enum class — <c>ShipmentStatus.PENDING</c> — not the first
    /// owner the translator finds in the global enum-member map (<c>RefundStatus.PENDING</c>).
    ///
    /// Before the fix <c>DefaultExpr</c> passed <c>null</c> as the enum hint, so the translator fell
    /// back to the first registered owner and emitted the wrong qualified name; mypy --strict then
    /// reported an "Incompatible types in assignment" error. The fix threads <c>EnumExpected(m, index)</c>
    /// so the field's own declared type is always used as the resolution hint.
    /// </summary>
    [Fact]
    public void Ambiguous_enum_member_default_resolves_to_correct_enum_class()
    {
        // Two contexts each declare an enum with a shared member name "Pending".
        // Context B's entity uses ShipmentStatus as the field type, defaulting to Pending.
        const string source = """
            context Refunds {
              enum RefundStatus { Pending Approved Rejected }
            }

            context Shipping {
              enum ShipmentStatus { Pending InTransit Delivered }

              aggregate Shipments root Shipment {
                entity Shipment identified by ShipmentId {
                  trackingCode: String
                  status: ShipmentStatus = Pending
                }
              }
            }
            """;

        var result = new KoineCompiler().Compile(source, new PythonEmitter());
        Assert.True(result.Success, string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        // The emitted entity must contain the CORRECT qualified default: ShipmentStatus.PENDING,
        // not RefundStatus.PENDING (which was the bug).
        var shipment = FileText(result.Files, "shipping/shipment.py");
        Assert.Contains("ShipmentStatus.PENDING", shipment);
        Assert.DoesNotContain("RefundStatus.PENDING", shipment);

        // Also gate with the toolchain: syntax + mypy --strict must pass.
        TestSupport.PythonCheck syntax = TestSupport.SyntaxCheckPython(result.Files);
        if (!syntax.ToolchainAvailable)
        {
            _output.WriteLine(NoInterpreterNotice);
        }
        else
        {
            Assert.True(syntax.Ok, "emitted Python should parse (ast.parse):\n" + string.Join("\n", syntax.Errors));
        }

        TestSupport.PythonCheck types = TestSupport.TypeCheckPython(result.Files);
        if (!types.ToolchainAvailable)
        {
            _output.WriteLine(NoToolchainNotice);
            return;
        }

        Assert.True(types.Ok, "emitted Python should type-check under mypy --strict:\n" + string.Join("\n", types.Errors));
    }

    /// <summary>The full text of an emitted file, by relative path (fails the test if absent).</summary>
    private static string FileText(IReadOnlyList<EmittedFile> files, string relativePath)
    {
        EmittedFile? file = files.FirstOrDefault(f => f.RelativePath == relativePath);
        Assert.True(file is not null, $"expected an emitted file at '{relativePath}'");
        return file!.Contents;
    }

    /// <summary>
    /// Runs the always-on syntax gate and the mypy <c>--strict</c> type-check over the emitted tree.
    /// Inconclusive (logged, not failed) when no toolchain is present; with one, BOTH must pass.
    /// </summary>
    private void AssertStrictlyTypeChecks(IReadOnlyList<EmittedFile> files)
    {
        TestSupport.PythonCheck syntax = TestSupport.SyntaxCheckPython(files);
        if (!syntax.ToolchainAvailable)
        {
            _output.WriteLine(NoInterpreterNotice);
        }
        else
        {
            Assert.True(syntax.Ok, "emitted Python should parse (ast.parse):\n" + string.Join("\n", syntax.Errors));
        }

        TestSupport.PythonCheck types = TestSupport.TypeCheckPython(files);
        if (!types.ToolchainAvailable)
        {
            _output.WriteLine(NoToolchainNotice);
            return;
        }

        Assert.True(types.Ok, "emitted Python should type-check under mypy --strict:\n" + string.Join("\n", types.Errors));
    }
}
