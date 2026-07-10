using Koine.Compiler.Emit;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests.Conformance;

/// <summary>
/// Conformance harness for the Python backend. This exercises the
/// <see cref="TestSupport.TypeCheckPython"/> plumbing (write emitted <c>.py</c> → run
/// <c>mypy --strict</c>) plus the always-on <see cref="TestSupport.SyntaxCheckPython"/>
/// (<c>ast.parse</c> over every emitted module) so it is ready to validate the Python emitter as it
/// lands. When no <c>mypy</c>/Python toolchain is present locally the check is funneled through
/// <see cref="TestSupport.RequireOrSkip"/>, which reports the test as <c>Skipped</c> (not a false
/// Passed) — keeping <c>dotnet test</c> green without a Python toolchain while surfacing the gap. It
/// NEVER silently passes a real error: a real error is only assertable when <c>mypy</c> is present,
/// and then it IS asserted. CI sets <c>KOINE_REQUIRE_CONFORMANCE</c> and installs the toolchain, so a
/// missing one there is a hard <c>Failed</c> rather than a silent skip.
/// </summary>
public class PythonConformanceTests
{
    private const string NoToolchainNotice =
        "No Python toolchain (mypy) available locally; type-check not run. " +
        "Install mypy (or set KOINE_MYPY) — CI runs this for real.";

    private const string NoInterpreterNotice =
        "No Python interpreter available locally; syntax check not run. " +
        "Install Python 3.11+ (or set KOINE_PYTHON) — CI runs this for real.";

    /// <summary>Clean, <c>--strict</c>-correct Python must type-check (skipped if no toolchain).</summary>
    [Fact]
    public void Harness_accepts_well_typed_python()
    {
        var files = new[]
        {
            new EmittedFile("ok.py", "def f(x: int) -> int:\n    return x\n"),
        };

        var r = TestSupport.TypeCheckPython(files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

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
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeFalse();
        r.Errors.ShouldNotBeEmpty();
    }

    /// <summary>
    /// The outcome contract <see cref="TestSupport.RequireOrSkip"/> relies on: a missing toolchain
    /// yields a <see cref="TestSupport.PythonCheck.Skipped"/> result whose <c>ToolchainAvailable</c> and
    /// <c>Ok</c> are both <c>false</c> — so it can never be mistaken for a real pass.
    /// </summary>
    [Fact]
    public void Skipped_result_does_not_claim_success()
    {
        TestSupport.PythonCheck.Skipped.ToolchainAvailable.ShouldBeFalse();
        TestSupport.PythonCheck.Skipped.Ok.ShouldBeFalse();
        TestSupport.PythonCheck.Skipped.Errors.ShouldBeEmpty();
    }

    /// <summary>
    /// The always-on syntax gate: a snippet using 3.11+ syntax (a <c>match</c> statement and a
    /// PEP&#160;604 <c>int | None</c> union) must parse via <c>ast.parse</c>. Skipped (not failed)
    /// only when no interpreter is present; with one it MUST parse cleanly.
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
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoInterpreterNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// The Task-5 acceptance check: the Python the emitter actually produces for the shared Phase-1
    /// fixture must parse (<c>ast.parse</c>) and type-check cleanly under <c>mypy --strict</c>. In this
    /// task only the regular value objects emit (the quantity/enum/entity/event constructs land
    /// later), so the tree is the runtime + root files + value-object modules + their <c>__init__.py</c>s
    /// — and it must be dangling-import-free and strict-clean. Skipped (not failed) only
    /// when no toolchain is present; with one it MUST pass with zero diagnostics.
    /// </summary>
    [Fact]
    public void Emitted_python_typechecks_under_strict()
    {
        var result = new KoineCompiler().Compile(PythonSnapshotTests.Fixture, new PythonEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        TestSupport.PythonCheck syntax = TestSupport.SyntaxCheckPython(result.Files);
        TestSupport.RequireOrSkip(syntax.ToolchainAvailable, NoInterpreterNotice);
        syntax.Ok.ShouldBeTrue("emitted Python should parse (ast.parse):\n" + string.Join("\n", syntax.Errors));

        TestSupport.PythonCheck types = TestSupport.TypeCheckPython(result.Files);
        TestSupport.RequireOrSkip(types.ToolchainAvailable, NoToolchainNotice);
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
        TestSupport.RequireOrSkip(syntax.ToolchainAvailable, NoInterpreterNotice);
        syntax.Ok.ShouldBeTrue("emitted Python should parse (ast.parse):\n" + string.Join("\n", syntax.Errors));

        TestSupport.PythonCheck types = TestSupport.TypeCheckPython(result.Files);
        TestSupport.RequireOrSkip(types.ToolchainAvailable, NoToolchainNotice);
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
        // One translate method per mapping (upstream → local), named for BOTH types so several
        // mappings sharing a source or target type stay distinct.
        acl.ShouldContain("def translate_account_to_customer(self, source: Account) -> Customer: ...");
        acl.ShouldContain("def translate_charge_to_invoice(self, source: Charge) -> Invoice: ...");

        AssertStrictlyTypeChecks(result.Files);
    }

    /// <summary>
    /// When the ACL's upstream and downstream contexts both declare a type of the SAME name, the
    /// translator's mapped upstream parameter must import the UPSTREAM copy — resolved against the
    /// mapping's declared context, not silently shadowed by the same-named downstream type (which the
    /// generic this-module-context-preferring import resolution would otherwise pick). Regression for
    /// the cross-context name-collision resolution.
    /// </summary>
    [Fact]
    public void Acl_upstream_type_colliding_with_downstream_name_imports_the_upstream_copy()
    {
        const string source = """
            context Provider {
              /// The provider's money shape (cents).
              value Money   { cents: Int }
            }

            context Ledger {
              /// Our OWN money shape — same name, different bounded context.
              value Money   { amount: Decimal }
              /// A posted ledger entry.
              value Entry   { note: String }
            }

            contextmap {
              Provider -> Ledger : anti-corruption-layer
                acl {
                  Provider.Money -> Ledger.Entry
                }
            }
            """;

        var result = new KoineCompiler().Compile(source, new PythonEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var acl = FileText(result.Files, "ledger/abstractions/provider_to_ledger_translator.py");
        acl.ShouldContain("def translate_money_to_entry(self, source: Money) -> Entry: ...");
        // The upstream `Money` resolves to Provider's module, NOT Ledger's same-named copy.
        acl.ShouldContain("from provider.value_objects.money import Money");
        acl.ShouldNotContain("from ledger.value_objects.money import Money");

        AssertStrictlyTypeChecks(result.Files);
    }

    /// <summary>
    /// Issue #241 acceptance: the full emitted set for a multi-aggregate context with a declarative finder
    /// — domain + the opt-in Infrastructure layer (concrete repository impls over the in-memory store, the
    /// unit of work, the pipeline behaviors and the provider) — must parse and type-check under
    /// <c>mypy --strict</c>. Skipped (not failed) only when no toolchain is present.
    /// </summary>
    [Fact]
    public void Emitted_infrastructure_typechecks_under_strict()
    {
        var result = new KoineCompiler().Compile(
            PythonInfrastructureSnapshotTests.Fixture,
            new PythonEmitter(PythonInfrastructureSnapshotTests.InfraOptions));
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        AssertStrictlyTypeChecks(result.Files);
    }

    /// <summary>
    /// Issue #241: a publishing context's infrastructure (the transactional outbox + dispatcher and the
    /// provider that wires them, plus the enqueue-on-save unit of work) must also parse and type-check
    /// under <c>mypy --strict</c>. Skipped (not failed) when no toolchain is present.
    /// </summary>
    [Fact]
    public void Emitted_publishing_infrastructure_typechecks_under_strict()
    {
        var result = new KoineCompiler().Compile(
            PythonInfrastructureSnapshotTests.PublishingFixture,
            new PythonEmitter(PythonInfrastructureSnapshotTests.InfraOptions));
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        AssertStrictlyTypeChecks(result.Files);
    }

    /// <summary>
    /// Issue #613: a single-line <c>///</c> doc whose text ends in a double-quote must not abut the
    /// closing <c>"""</c> delimiter. The buggy emit concatenated them into <c>""""</c> (four quotes) —
    /// the tokenizer closes the docstring after the first three and is left with a dangling <c>"</c>,
    /// a module-level <c>SyntaxError</c> that breaks the WHOLE emitted module. The emitter now promotes
    /// such a docstring to the multi-line form (closing <c>"""</c> on its own line), so the content and
    /// the delimiter never collide. Toolchain-free: asserts the emitted shape directly.
    /// </summary>
    [Fact]
    public void Single_line_doc_ending_in_quote_does_not_collide_with_closing_delimiter()
    {
        const string source = """
            context Vault {
              /// Wrap the key "K"
              value WrapKey {
                code: String
              }
            }
            """;

        var result = new KoineCompiler().Compile(source, new PythonEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var module = FileText(result.Files, "vault/value_objects/wrap_key.py");
        // The trailing quote must not merge with the closing delimiter into a four-quote run.
        module.ShouldNotContain("\"\"\"\"");
        // It is promoted to the multi-line form: content then the closing """ on its OWN line.
        module.ShouldContain("\"\"\"Wrap the key \"K\"\n");
    }

    /// <summary>
    /// Issue #613, the parse safety net: a single-line doc abutting the closing delimiter in any of
    /// the awkward ways — a trailing single/double quote, a lone quote, an embedded triple-quote run,
    /// or a trailing backslash — must always emit a module that <c>ast.parse</c>s. Skipped (not failed)
    /// only when no Python interpreter is present; with one it MUST parse.
    /// </summary>
    [Theory]
    [InlineData("Wrap the key \"K\"")] // ends in one quote (the reported bug)
    [InlineData("She said \"\"")]       // ends in two quotes
    [InlineData("\"")]                   // the doc IS a lone quote
    [InlineData("A literal \"\"\" run")] // an embedded triple-quote run
    [InlineData("A path C:\\")]          // ends in a backslash
    public void Single_line_doc_with_delimiter_edges_emits_parseable_python(string doc)
    {
        string source = $$"""
            context Vault {
              /// {{doc}}
              value WrapKey {
                code: String
              }
            }
            """;

        var result = new KoineCompiler().Compile(source, new PythonEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        TestSupport.PythonCheck syntax = TestSupport.SyntaxCheckPython(result.Files);
        TestSupport.RequireOrSkip(syntax.ToolchainAvailable, NoInterpreterNotice);
        syntax.Ok.ShouldBeTrue("emitted Python should parse (ast.parse):\n" + string.Join("\n", syntax.Errors));
    }

    /// <summary>
    /// Issue #712 acceptance (Python half): a <c>distinctBy</c> over an <em>entity</em> selector must
    /// dedupe <b>by id</b> at runtime, matching C#'s <c>.Distinct()</c> and PHP (post-#687). Unlike a
    /// JS <c>Set</c> (reference identity) or PHP <c>array_unique</c> (string cast), the emitted Python
    /// <c>len({i for i in self.items}) == len(self.items)</c> relies on the entity's identity
    /// <c>__eq__</c>/<c>__hash__</c> (over its id) — so the set already collapses two distinct
    /// instances that share an id. This EXECUTES the emitted code (the runtime hazard the issue
    /// feared, which mypy/ast can't see): two lines with the same id but different <c>qty</c> count as
    /// a duplicate; distinct ids count as all-unique. Skipped (not failed) when no Python interpreter
    /// is present locally; CI runs it for real. No emitter change was needed — this guards the
    /// behavior so the correct <c>set</c> path can't silently regress.
    /// </summary>
    [Fact]
    public void DistinctBy_over_entity_selector_dedupes_by_id_at_runtime()
    {
        const string src = """
            context Shop {
              aggregate Cart root Basket {
                entity Line identified by LineId { qty: Int }
                entity Basket identified by BasketId {
                  lines: List<Line>
                  uniqueLines: Bool = lines.distinctBy(l => l)
                }
              }
            }
            """;
        var result = new KoineCompiler().Compile(src, new PythonEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        const string driver = """
            from shop.entities.line import Line
            from shop.value_objects.line_id import LineId
            from shop.value_objects.basket_id import BasketId
            from shop.basket import Basket

            # Two lines with the SAME id but different qty: structurally different, same identity.
            dup = Basket(BasketId("b1"), (Line(LineId("a"), 1), Line(LineId("a"), 99), Line(LineId("c"), 2)))
            assert dup.unique_lines is False, "same-id lines must count as a duplicate (by id), like C#.Distinct()"

            # Distinct ids: every line is unique.
            distinct = Basket(BasketId("b2"), (Line(LineId("a"), 1), Line(LineId("b"), 2)))
            assert distinct.unique_lines is True, "distinct ids must count as all-unique"
            """;

        TestSupport.PythonCheck run = TestSupport.RunPython(result.Files, driver);
        TestSupport.RequireOrSkip(run.ToolchainAvailable, NoInterpreterNotice);
        run.Ok.ShouldBeTrue("entity distinctBy should dedupe by id at runtime:\n" + string.Join("\n", run.Errors));
    }

    /// <summary>
    /// Issue #788 acceptance: <c>scalar * value-object</c> with the scalar on the LEFT
    /// (<c>1.1 * base</c>) must type-check under <c>mypy --strict</c> AND evaluate without a
    /// <c>TypeError</c> at runtime. The Python translator keeps native infix
    /// (<c>Decimal("1.1") * self.base</c>); the generated value object's new <c>__rmul__</c>
    /// (delegating to <c>__mul__</c>) is what makes Python's reflected-operand fallback
    /// (<c>Decimal.__mul__(Money)</c> → <c>NotImplemented</c> → <c>Money.__rmul__</c>) resolve. Before
    /// the fix <c>0.9 * base</c> raised <c>TypeError: unsupported operand type(s)</c>. Mirrors the
    /// merged PHP Bug-2 fix (#778); the model exercises both operand orders.
    /// </summary>
    [Fact]
    public void Reversed_scalar_times_value_object_typechecks_and_runs()
    {
        const string src = """
            context Shop {
              value Money {
                amount: Decimal
                invariant amount >= 0 "an amount cannot be negative"
              }
              value Line {
                base: Money
                discounted: Money = base * 0.9
                surcharged: Money = 1.1 * base
              }
            }
            """;
        var result = new KoineCompiler().Compile(src, new PythonEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        TestSupport.PythonCheck types = TestSupport.TypeCheckPython(result.Files);
        TestSupport.RequireOrSkip(types.ToolchainAvailable, NoToolchainNotice);
        types.Ok.ShouldBeTrue(
            "scalar * value-object should type-check under mypy --strict:\n" + string.Join("\n", types.Errors));

        const string driver = """
            from decimal import Decimal
            from shop.value_objects.money import Money
            from shop.value_objects.line import Line

            line = Line(Money(Decimal("100")))
            # `discounted = base * 0.9` (value object on the LEFT) and `surcharged = 1.1 * base`
            # (scalar on the LEFT — the reversed order #788 is about) must BOTH evaluate, no TypeError.
            assert line.discounted.amount == Decimal("90.0"), line.discounted.amount
            assert line.surcharged.amount == Decimal("110.0"), line.surcharged.amount
            """;

        TestSupport.PythonCheck run = TestSupport.RunPython(result.Files, driver);
        TestSupport.RequireOrSkip(run.ToolchainAvailable, NoInterpreterNotice);
        run.Ok.ShouldBeTrue(
            "reversed scalar * value-object should evaluate without TypeError:\n" + string.Join("\n", run.Errors));
    }

    /// <summary>
    /// Issue #879 (follow-up to #832, which demand-generated <c>operator /</c> for the C# emitter):
    /// a plain value object divided by a numeric scalar — <c>half: Money = base / 2</c> — must emit a
    /// real <c>__truediv__</c>, mirroring the existing demand-generated <c>__mul__</c>. Before the fix
    /// <c>OperatorNeedsAnalyzer.BuildScalarDivisionNeeds</c> was recorded but never consumed by the
    /// Python emitter, so <c>base / 2</c> raised <c>TypeError: unsupported operand type(s)</c> at
    /// runtime (Python already lowers <c>/</c> to the native operator — see
    /// <c>PythonExpressionTranslator.BinaryOperatorFor</c> — so only the emission was missing, not the
    /// translator routing).
    /// </summary>
    [Fact]
    public void Value_object_divided_by_a_scalar_typechecks_and_runs()
    {
        const string src = """
            context Shop {
              value Money {
                amount: Decimal
                invariant amount >= 0 "an amount cannot be negative"
              }
              value Line {
                base: Money
                half: Money = base / 2
              }
            }
            """;
        var result = new KoineCompiler().Compile(src, new PythonEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var rendered = TestSupport.Render(result.Files);
        rendered.ShouldContain("__truediv__");

        AssertStrictlyTypeChecks(result.Files);

        const string driver = """
            from decimal import Decimal
            from shop.value_objects.money import Money
            from shop.value_objects.line import Line

            line = Line(Money(Decimal("10")))
            assert line.half.amount == Decimal("5"), line.half.amount
            """;

        TestSupport.PythonCheck run = TestSupport.RunPython(result.Files, driver);
        TestSupport.RequireOrSkip(run.ToolchainAvailable, NoInterpreterNotice);
        run.Ok.ShouldBeTrue(
            "value-object / scalar should evaluate (10/2==5):\n" + string.Join("\n", run.Errors));
    }

    /// <summary>
    /// Issue #834: a plain (non-quantity) value object used directly in binary arithmetic —
    /// <c>combined: Money = base + base</c> / <c>diff: Money = base - base</c> — must emit real
    /// <c>__add__</c> / <c>__sub__</c> dunders so the native <c>+</c>/<c>-</c> the translator lowers to
    /// resolve. Before the fix the emitter only generated <c>__add__</c> (and only when the VO was
    /// <c>sum</c>-folded), so <c>base - base</c> had no <c>__sub__</c> (a runtime <c>TypeError</c> /
    /// mypy error). Brings Python to parity with PHP/C#. The dunders must also <c>--strict</c>-check;
    /// a runtime driver proves <c>10 + 10 == 20</c> and <c>10 - 10 == 0</c>.
    /// </summary>
    [Fact]
    public void Value_object_plain_arithmetic_typechecks_under_mypy_strict()
    {
        const string src = """
            context Shop {
              value Money {
                amount: Decimal
                invariant amount >= 0 "an amount cannot be negative"
              }
              value Line {
                base: Money
                combined: Money = base + base
                diff: Money = base - base
              }
            }
            """;
        var result = new KoineCompiler().Compile(src, new PythonEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var rendered = TestSupport.Render(result.Files);
        rendered.ShouldContain("__sub__");

        AssertStrictlyTypeChecks(result.Files);

        const string driver = """
            from decimal import Decimal
            from shop.value_objects.money import Money
            from shop.value_objects.line import Line

            line = Line(Money(Decimal("10")))
            assert line.combined.amount == Decimal("20"), line.combined.amount
            assert line.diff.amount == Decimal("0"), line.diff.amount
            """;

        TestSupport.PythonCheck run = TestSupport.RunPython(result.Files, driver);
        TestSupport.RequireOrSkip(run.ToolchainAvailable, NoInterpreterNotice);
        run.Ok.ShouldBeTrue(
            "plain value-object +/- should evaluate (10+10==20, 10-10==0):\n" + string.Join("\n", run.Errors));
    }

    /// <summary>
    /// Issue #938 cross-target parity: Python already truncates an <c>Int</c> field's scalar divide
    /// toward zero (<c>int(self.grams / divisor)</c> — Python's <c>/</c> is always true division, so the
    /// quotient is cast with <c>int(...)</c>, matching C#'s <c>(int)</c> cast). This pins that behavior
    /// so it can't silently regress while the TypeScript emitter is being brought into line (the same
    /// issue's actual fix). A runtime driver proves the negative-operand case truncates toward zero
    /// (<c>-7 / 2 == -3</c>), not toward negative infinity (<c>floor(-7 / 2) == -4</c>, which Python's own
    /// <c>//</c> operator would give — this emitter deliberately uses true division + <c>int(...)</c>,
    /// not <c>//</c>, to get truncation rather than floor).
    /// </summary>
    [Fact]
    public void Int_field_scalar_divide_truncates_toward_zero()
    {
        const string src = """
            context Shop {
              value Weight {
                grams: Int
              }
              value Box {
                total: Weight
                half: Weight = total / 2
              }
            }
            """;
        var result = new KoineCompiler().Compile(src, new PythonEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var rendered = TestSupport.Render(result.Files);
        rendered.ShouldContain("int(self.grams / divisor)");

        AssertStrictlyTypeChecks(result.Files);

        const string driver = """
            from shop.value_objects.weight import Weight

            positive = Weight(7) / 2
            negative = Weight(-7) / 2
            assert positive.grams == 3, positive.grams
            assert negative.grams == -3, negative.grams
            """;

        TestSupport.PythonCheck run = TestSupport.RunPython(result.Files, driver);
        TestSupport.RequireOrSkip(run.ToolchainAvailable, NoInterpreterNotice);
        run.Ok.ShouldBeTrue(
            "Int-field divide should truncate toward zero (7/2==3, -7/2==-3):\n" + string.Join("\n", run.Errors));
    }

    /// <summary>
    /// Issue #1344: a <c>ConditionalExpr</c> derived-member body whose branches disagree ONLY in numeric
    /// type (a non-optional <c>Int</c> branch against a <c>Decimal</c> sibling) must widen the <c>Int</c>
    /// branch to <c>Decimal(...)</c> so both ternary arms share a type — <c>mypy --strict</c> rejects an
    /// unreconciled <c>int | Decimal</c> return where a bare <c>Decimal</c> is declared. Before the fix
    /// this emitted an unreconciled <c>(self.a if (self.a > 0) else self.b)</c> that fails
    /// <c>mypy --strict</c> with "Incompatible return value type (got \"int | Decimal\", expected
    /// \"Decimal\")".
    /// </summary>
    [Fact]
    public void Conditional_branch_numeric_widen_typechecks_under_strict()
    {
        const string src = """
            context Shop {
              value Line {
                a: Int
                b: Decimal
                total: Decimal = if a > 0 then a else b
              }
            }
            """;
        var result = new KoineCompiler().Compile(src, new PythonEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var rendered = TestSupport.Render(result.Files);
        rendered.ShouldContain("Decimal(self.a)");

        AssertStrictlyTypeChecks(result.Files);
    }

    /// <summary>
    /// Issue #1344: a <c>ConditionalExpr</c> derived-member body whose branches disagree ONLY in
    /// optionality (a non-optional branch against an optional sibling of the SAME underlying type) is
    /// already <c>mypy --strict</c>-clean in Python with no emitter change: an optional Koine type maps
    /// to a plain PEP&#160;604 union with <c>None</c> (<c>T | None</c>), and a bare <c>T</c> value is
    /// structurally assignable wherever <c>T | None</c> is expected — unlike Rust's <c>Option&lt;T&gt;</c>
    /// or Java's <c>Optional&lt;T&gt;</c>, which are distinct nominal types that need an explicit wrap
    /// (mirrors the TypeScript/Kotlin conclusion for their own structural-union optional shapes, verified
    /// here against real <c>mypy --strict</c>). This guards that Python keeps taking the no-op path (no
    /// wrap emitted) for this shape.
    /// </summary>
    [Fact]
    public void Conditional_branch_optionality_only_mismatch_typechecks_under_strict()
    {
        const string src = """
            context Shop {
              value Money {
                amount: Int
                bonus: Int?
                total: Int? = if amount > 0 then amount else bonus
              }
            }
            """;
        var result = new KoineCompiler().Compile(src, new PythonEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        AssertStrictlyTypeChecks(result.Files);
    }

    /// <summary>
    /// Issue #1344 (the issue's exact repro): a <c>ConditionalExpr</c> derived-member body whose branches
    /// disagree in BOTH numeric type and optionality at once — a non-optional <c>Decimal</c> branch
    /// against an optional <c>Int</c> sibling — must null-check-and-widen the optional <c>Int</c> branch
    /// so both ternary arms are <c>Decimal | None</c>-compatible. Before the fix Python rendered a bare
    /// <c>(self.decimal_amount if (self.decimal_amount > 0) else self.int_bonus)</c> — a <c>Decimal</c>
    /// against a bare <c>int | None</c> — which <c>mypy --strict</c> rejects with exactly "Incompatible
    /// return value type (got \"Decimal | int | None\", expected \"Decimal | None\")".
    /// </summary>
    [Fact]
    public void Conditional_branch_with_optional_int_widen_typechecks_under_strict()
    {
        const string src = """
            context Shop {
              value Money {
                decimalAmount: Decimal
                intBonus: Int?
                total: Decimal? = if decimalAmount > 0 then decimalAmount else intBonus
              }
            }
            """;
        var result = new KoineCompiler().Compile(src, new PythonEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var rendered = TestSupport.Render(result.Files);
        rendered.ShouldContain("Decimal(__koine_v) if (__koine_v := self.int_bonus) is not None else None");

        AssertStrictlyTypeChecks(result.Files);
    }

    /// <summary>
    /// Issue #1344: the <c>needsWiden</c> widen must apply against an OPTIONAL <c>Decimal?</c> sibling
    /// too (not just a non-optional one) — a non-optional <c>Int</c> branch against a <c>Decimal?</c>
    /// sibling must still widen to <c>Decimal(...)</c>; no further wrap is needed since a bare
    /// <c>Decimal</c> is already assignable where <c>Decimal | None</c> is expected. Mirrors the
    /// Rust/Java/TypeScript <c>Cash</c> fixture's widen(+wrap) composition case (Python, like TypeScript,
    /// never needs the wrap half — see
    /// <see cref="Conditional_branch_optionality_only_mismatch_typechecks_under_strict"/>).
    /// </summary>
    [Fact]
    public void Conditional_branch_numeric_widen_against_optional_sibling_typechecks_under_strict()
    {
        const string src = """
            context Shop {
              value Cash {
                amount: Int
                bonusAmount: Decimal?
                total: Decimal? = if amount > 0 then amount else bonusAmount
              }
            }
            """;
        var result = new KoineCompiler().Compile(src, new PythonEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var rendered = TestSupport.Render(result.Files);
        rendered.ShouldContain("Decimal(self.amount)");

        AssertStrictlyTypeChecks(result.Files);
    }

    /// <summary>
    /// Issue #1344: a nested <c>ConditionalExpr</c> used as one branch of an outer conditional must itself
    /// reconcile its own two arms BEFORE the outer branch is emitted, so the inner ternary's inferred
    /// (joined, #975) type lines up with the outer sibling's type. Here the inner <c>if</c> widens
    /// <c>amount</c> (<c>Int</c>) against <c>bonus</c> (<c>Decimal</c>) to <c>Decimal</c>, which then
    /// already matches the outer <c>else</c> branch <c>fallback: Decimal</c> with no further outer-level
    /// reconciliation needed.
    /// </summary>
    [Fact]
    public void Conditional_branch_with_nested_conditional_typechecks_under_strict()
    {
        const string src = """
            context Shop {
              value Money {
                amount: Int
                bonus: Decimal
                fallback: Decimal
                total: Decimal = if amount > 0 then (if amount > 10 then amount else bonus) else fallback
              }
            }
            """;
        var result = new KoineCompiler().Compile(src, new PythonEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var rendered = TestSupport.Render(result.Files);
        rendered.ShouldContain("Decimal(self.amount)");

        AssertStrictlyTypeChecks(result.Files);
    }

    /// <summary>
    /// Issue #1344 code-review follow-up: <c>needsOptionalWiden</c>'s branch must type-check under
    /// <c>mypy --strict</c> even when the branch itself is a COMPOUND expression (here a nested
    /// <c>ConditionalExpr</c>), not just a bare identifier/attribute access. <c>is not None</c> can only
    /// narrow a simple name/attribute chain, not a re-occurring arbitrary sub-expression — an earlier
    /// version of this fix duplicated the branch's rendered text into both the guard and the value
    /// position, which mypy could narrow for a bare field (the other <c>needsOptionalWiden</c> tests above)
    /// but rejected for this nested-conditional shape with "Argument 1 to &quot;Decimal&quot; has
    /// incompatible type". Binding the branch once via a walrus fixes both the narrowing and the
    /// double-evaluation.
    /// </summary>
    [Fact]
    public void Conditional_branch_with_optional_int_widen_over_compound_branch_typechecks_under_strict()
    {
        const string src = """
            context Shop {
              value Money {
                decimalField: Decimal
                flag: Bool
                bonus1: Int?
                bonus2: Int?
                total: Decimal? = if decimalField > 0 then (if flag then bonus1 else bonus2) else decimalField
              }
            }
            """;
        var result = new KoineCompiler().Compile(src, new PythonEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var rendered = TestSupport.Render(result.Files);
        rendered.ShouldContain("Decimal(__koine_v) if (__koine_v := (self.bonus1 if self.flag else self.bonus2)) is not None else None");

        AssertStrictlyTypeChecks(result.Files);
    }

    /// <summary>The full text of an emitted file, by relative path (fails the test if absent).</summary>
    private static string FileText(IReadOnlyList<EmittedFile> files, string relativePath)
    {
        EmittedFile? file = files.FirstOrDefault(f => f.RelativePath == relativePath);
        (file is not null).ShouldBeTrue($"expected an emitted file at '{relativePath}'");
        return file.Contents;
    }

    /// <summary>
    /// Runs the always-on syntax gate and the mypy <c>--strict</c> type-check over the emitted tree.
    /// Skipped (not failed) when no toolchain is present; with one, BOTH must pass.
    /// </summary>
    private static void AssertStrictlyTypeChecks(IReadOnlyList<EmittedFile> files)
    {
        TestSupport.PythonCheck syntax = TestSupport.SyntaxCheckPython(files);
        TestSupport.RequireOrSkip(syntax.ToolchainAvailable, NoInterpreterNotice);
        syntax.Ok.ShouldBeTrue("emitted Python should parse (ast.parse):\n" + string.Join("\n", syntax.Errors));

        TestSupport.PythonCheck types = TestSupport.TypeCheckPython(files);
        TestSupport.RequireOrSkip(types.ToolchainAvailable, NoToolchainNotice);
        types.Ok.ShouldBeTrue("emitted Python should type-check under mypy --strict:\n" + string.Join("\n", types.Errors));
    }
}
