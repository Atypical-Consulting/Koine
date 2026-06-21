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

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
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

        r.Ok.ShouldBeFalse();
        r.Errors.ShouldNotBeEmpty();
    }

    /// <summary>A missing toolchain yields an inconclusive-shaped result rather than a false pass.</summary>
    [Fact]
    public void Skipped_result_does_not_claim_success()
    {
        TestSupport.PythonCheck.Skipped.ToolchainAvailable.ShouldBeFalse();
        TestSupport.PythonCheck.Skipped.Ok.ShouldBeFalse();
        TestSupport.PythonCheck.Skipped.Errors.ShouldBeEmpty();
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

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
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
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        TestSupport.PythonCheck syntax = TestSupport.SyntaxCheckPython(result.Files);
        if (!syntax.ToolchainAvailable)
        {
            _output.WriteLine(NoInterpreterNotice);
        }
        else
        {
            syntax.Ok.ShouldBeTrue("emitted Python should parse (ast.parse):\n" + string.Join("\n", syntax.Errors));
        }

        TestSupport.PythonCheck types = TestSupport.TypeCheckPython(result.Files);
        if (!types.ToolchainAvailable)
        {
            _output.WriteLine(NoToolchainNotice);
            return;
        }

        types.Ok.ShouldBeTrue("emitted Python should type-check under mypy --strict:\n" + string.Join("\n", types.Errors));
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
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        // The versioned root carries `version` and is marked an AggregateRoot; the repository is an
        // async Protocol. Assert the emitted shapes regardless of toolchain availability.
        var root = FileText(result.Files, "inventory/stock.py");
        root.ShouldContain("version: int = 0");
        root.ShouldContain("_AGGREGATE_ROOT_CHECK: type[AggregateRoot] = Stock");

        var repo = FileText(result.Files, "inventory/repositories/stock_repository.py");
        repo.ShouldContain("class StockRepository(Protocol):");
        repo.ShouldContain("async def get(self, id: StockId) -> Stock | None: ...");
        repo.ShouldContain("async def save(self, aggregate: Stock) -> None: ...");
        repo.ShouldContain("async def by_sku(self, sku: str) -> Stock | None: ...");

        var domainService = FileText(result.Files, "inventory/reorder_policy.py");
        domainService.ShouldContain("class ReorderPolicy(Protocol):");
        domainService.ShouldContain("def needs_reorder(self, level: int, threshold: int) -> bool:");

        var appService = FileText(result.Files, "inventory/stock_app_service.py");
        appService.ShouldContain("class StockAppService(Protocol):");
        appService.ShouldContain("async def adjust_level(self, stock: StockId, delta: int) -> StockId: ...");
        appService.ShouldContain("async def retire(self, stock: StockId) -> None: ...");

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
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        // The cross-context `Sku` resolves to Catalog's real module — in the value object and the repo.
        var line = FileText(result.Files, "sales/value_objects/basket_line.py");
        line.ShouldContain("from catalog.value_objects.sku import Sku");

        var repo = FileText(result.Files, "sales/repositories/basket_repository.py");
        repo.ShouldContain("from catalog.value_objects.sku import Sku");
        repo.ShouldContain("async def by_sku(self, sku: Sku) -> tuple[Basket, ...]: ...");

        // The root emits at the context package root (not under entities/).
        result.Files.ShouldContain(f => f.RelativePath == "sales/basket.py");

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
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        // The emitted entity must contain the CORRECT qualified default: ShipmentStatus.PENDING,
        // not RefundStatus.PENDING (which was the bug).
        var shipment = FileText(result.Files, "shipping/shipment.py");
        shipment.ShouldContain("ShipmentStatus.PENDING");
        shipment.ShouldNotContain("RefundStatus.PENDING");

        // Also gate with the toolchain: syntax + mypy --strict must pass.
        TestSupport.PythonCheck syntax = TestSupport.SyntaxCheckPython(result.Files);
        if (!syntax.ToolchainAvailable)
        {
            _output.WriteLine(NoInterpreterNotice);
        }
        else
        {
            syntax.Ok.ShouldBeTrue("emitted Python should parse (ast.parse):\n" + string.Join("\n", syntax.Errors));
        }

        TestSupport.PythonCheck types = TestSupport.TypeCheckPython(result.Files);
        if (!types.ToolchainAvailable)
        {
            _output.WriteLine(NoToolchainNotice);
            return;
        }

        types.Ok.ShouldBeTrue("emitted Python should type-check under mypy --strict:\n" + string.Join("\n", types.Errors));
    }

    /// <summary>
    /// An anti-corruption-layer relation carrying an <c>acl { … }</c> mapping block must emit a
    /// translator <c>Protocol</c> seam into the DOWNSTREAM context (<c>billing/abstractions/</c>),
    /// with one <c>translate_&lt;local&gt;(source: &lt;Upstream&gt;) -&gt; &lt;Local&gt;</c> per mapping —
    /// the Python analogue of the C# <c>I&lt;Up&gt;To&lt;Down&gt;Translator</c> / TS interface. The
    /// upstream types resolve to QUALIFIED cross-context imports (never a guessed relative path) via the
    /// shared type-location table, and the whole tree type-checks under <c>mypy --strict</c>. Proves
    /// Part D (context maps / ACL), which the single-context main fixture cannot exercise.
    /// </summary>
    [Fact]
    public void Acl_relation_emits_qualified_translator_protocol_and_typechecks()
    {
        const string source = """
            context Legacy {
              /// The external provider's raw account shape.
              value Account { reference: String }
              /// The external provider's raw charge shape.
              value Charge  { amount: Decimal }
            }

            context Billing {
              /// Our clean customer model.
              value Customer { name: String }
              /// Our clean invoice model.
              value Invoice  { total: Decimal }
            }

            contextmap {
              Legacy -> Billing : anti-corruption-layer
                acl {
                  Legacy.Account -> Billing.Customer
                  Legacy.Charge  -> Billing.Invoice
                }
            }
            """;

        var result = new KoineCompiler().Compile(source, new PythonEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var acl = FileText(result.Files, "billing/abstractions/legacy_to_billing_translator.py");
        acl.ShouldContain("class LegacyToBillingTranslator(Protocol):");
        // The upstream types resolve to qualified cross-context imports into Legacy's real modules.
        acl.ShouldContain("from legacy.value_objects.account import Account");
        acl.ShouldContain("from legacy.value_objects.charge import Charge");
        // One translate method per mapping (upstream → local), disambiguated by the local type name.
        acl.ShouldContain("def translate_customer(self, source: Account) -> Customer: ...");
        acl.ShouldContain("def translate_invoice(self, source: Charge) -> Invoice: ...");

        AssertStrictlyTypeChecks(result.Files);
    }

    /// <summary>The full text of an emitted file, by relative path (fails the test if absent).</summary>
    private static string FileText(IReadOnlyList<EmittedFile> files, string relativePath)
    {
        EmittedFile? file = files.FirstOrDefault(f => f.RelativePath == relativePath);
        (file is not null).ShouldBeTrue($"expected an emitted file at '{relativePath}'");
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
            syntax.Ok.ShouldBeTrue("emitted Python should parse (ast.parse):\n" + string.Join("\n", syntax.Errors));
        }

        TestSupport.PythonCheck types = TestSupport.TypeCheckPython(files);
        if (!types.ToolchainAvailable)
        {
            _output.WriteLine(NoToolchainNotice);
            return;
        }

        types.Ok.ShouldBeTrue("emitted Python should type-check under mypy --strict:\n" + string.Join("\n", types.Errors));
    }
}
