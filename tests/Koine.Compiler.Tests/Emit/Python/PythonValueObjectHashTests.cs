using Koine.Compiler.Emit;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Regression coverage for issues #612 and #657: a frozen Python value object that contains a
/// <c>Map&lt;K,V&gt;</c> anywhere in a field's type must stay hashable. A <c>Map</c> maps to a
/// dict-backed <c>Mapping</c> (unhashable), so the dataclass's free structural <c>__hash__</c> (from
/// <c>frozen=True</c>) threw <c>TypeError: unhashable type: 'dict'</c> the moment such a value object
/// was hashed. The emitter emits <c>eq=False</c> plus explicit structural <c>__eq__</c>/<c>__hash__</c>
/// that fold every reachable Map into a <c>frozenset(items())</c> — recursing through nested
/// <c>List&lt;Map&gt;</c> / <c>Map&lt;K, Map&gt;</c> shapes (#657), not just top-level Map fields
/// (#612). These tests assert the emitted SHAPE (env-independent) and — when a Python interpreter is
/// present — actually EXECUTE the hashing (the runtime hazard mypy/ast can't see).
/// </summary>
public class PythonValueObjectHashTests
{
    private const string Source =
        """
        context Catalog {
          value PriceBook {
            prices: Map<String, Int>
          }

          value Catalogue {
            name: String
            prices: Map<String, Int>
          }

          value MaybePrices {
            prices: Map<String, Int>?
          }

          // Nested-Map shapes (#657): a Map reachable BELOW the top level of a field's type.
          value Buckets {
            rows: List<Map<String, Int>>
          }

          value Grid {
            cells: Map<String, Map<String, Int>>
          }

          value Ledger {
            byKey: Map<String, List<Map<String, Int>>>
          }

          value MaybeGrid {
            cells: Map<String, Map<String, Int>>?
          }

          value Plain {
            code: String
            count: Int
          }
        }
        """;

    private const string NoInterpreterNotice =
        "No Python interpreter available locally; runtime hash check not run. " +
        "Install Python 3.11+ (or set KOINE_PYTHON) — CI runs this for real.";

    private static IReadOnlyList<EmittedFile> Emit()
    {
        var result = new KoineCompiler().Compile(Source, new PythonEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        return result.Files;
    }

    private static string FileEndingWith(IReadOnlyList<EmittedFile> files, string suffix) =>
        files.First(f => f.RelativePath.EndsWith(suffix, StringComparison.Ordinal)).Contents;

    [Fact]
    public void Value_object_with_a_single_map_field_emits_eq_false_and_structural_dunders()
    {
        string py = FileEndingWith(Emit(), "value_objects/price_book.py");

        py.ShouldContain("@dataclass(frozen=True, eq=False)");
        py.ShouldContain("def __eq__(self, other: object) -> bool:");
        py.ShouldContain("return isinstance(other, PriceBook) and self.prices == other.prices");
        py.ShouldContain("def __hash__(self) -> int:");
        py.ShouldContain("return hash((frozenset(self.prices.items()),))");
    }

    [Fact]
    public void Multi_field_value_object_folds_every_field_into_eq_and_hash()
    {
        string py = FileEndingWith(Emit(), "value_objects/catalogue.py");

        py.ShouldContain("@dataclass(frozen=True, eq=False)");
        py.ShouldContain(
            "return isinstance(other, Catalogue) and self.name == other.name and self.prices == other.prices");
        // Non-Map field stays as-is; the Map field folds to frozenset(items()).
        py.ShouldContain("return hash((self.name, frozenset(self.prices.items())))");
    }

    [Fact]
    public void Optional_map_field_guards_items_against_none()
    {
        string py = FileEndingWith(Emit(), "value_objects/maybe_prices.py");

        py.ShouldContain("@dataclass(frozen=True, eq=False)");
        py.ShouldContain(
            "return hash((frozenset(self.prices.items()) if self.prices is not None else None,))");
    }

    [Fact]
    public void Map_nested_in_a_list_field_emits_dunders_and_folds_each_element()
    {
        string py = FileEndingWith(Emit(), "value_objects/buckets.py");

        // #654 missed this entirely: a List<Map> field is not a top-level Map, so the old top-level
        // detection emitted a plain @dataclass(frozen=True) with no dunders — and it threw at runtime.
        py.ShouldContain("@dataclass(frozen=True, eq=False)");
        py.ShouldContain("def __hash__(self) -> int:");
        py.ShouldContain("return hash((tuple(frozenset(x0.items()) for x0 in self.rows),))");
    }

    [Fact]
    public void Map_with_a_map_value_recursively_folds_the_value_side()
    {
        string py = FileEndingWith(Emit(), "value_objects/grid.py");

        // #654 folded only the OUTER Map; each value stayed a dict, so hashing still threw.
        py.ShouldContain("@dataclass(frozen=True, eq=False)");
        py.ShouldContain(
            "return hash((frozenset((k0, frozenset(v0.items())) for k0, v0 in self.cells.items()),))");
    }

    [Fact]
    public void Deeply_nested_map_under_list_under_map_folds_at_every_level()
    {
        string py = FileEndingWith(Emit(), "value_objects/ledger.py");

        // Map<K, List<Map>>: fold the outer Map's value (a tuple) element-wise, then each element's Map.
        py.ShouldContain("@dataclass(frozen=True, eq=False)");
        py.ShouldContain(
            "return hash((frozenset((k0, tuple(frozenset(x1.items()) for x1 in v0)) for k0, v0 in self.by_key.items()),))");
    }

    [Fact]
    public void Optional_nested_map_field_guards_the_recursive_fold_against_none()
    {
        string py = FileEndingWith(Emit(), "value_objects/maybe_grid.py");

        py.ShouldContain("@dataclass(frozen=True, eq=False)");
        py.ShouldContain(
            "return hash((frozenset((k0, frozenset(v0.items())) for k0, v0 in self.cells.items()) if self.cells is not None else None,))");
    }

    [Fact]
    public void Value_object_without_a_map_field_is_unchanged()
    {
        string py = FileEndingWith(Emit(), "value_objects/plain.py");

        py.ShouldContain("@dataclass(frozen=True)");
        py.ShouldNotContain("eq=False");
        py.ShouldNotContain("def __hash__");
        py.ShouldNotContain("def __eq__");
    }

    /// <summary>
    /// The runtime proof (issue #612's actual symptom): constructing and hashing a frozen value object
    /// with a Map field — putting it in a set, using it as a dict key — must NOT raise. Skipped when no
    /// Python interpreter is available; CI runs it for real.
    /// </summary>
    [Fact]
    public void Frozen_value_objects_with_map_fields_are_hashable_at_runtime()
    {
        const string driver =
            """
            from catalog.value_objects.price_book import PriceBook
            from catalog.value_objects.catalogue import Catalogue
            from catalog.value_objects.maybe_prices import MaybePrices
            from catalog.value_objects.buckets import Buckets
            from catalog.value_objects.grid import Grid
            from catalog.value_objects.ledger import Ledger
            from catalog.value_objects.maybe_grid import MaybeGrid

            # Single Map field: hashable, structurally equal, usable in a set and as a dict key.
            pb = PriceBook(prices={"a": 1, "b": 2})
            assert pb == PriceBook(prices={"a": 1, "b": 2})
            assert hash(pb) == hash(PriceBook(prices={"b": 2, "a": 1}))  # order-insensitive
            assert len({pb, PriceBook(prices={"a": 1, "b": 2})}) == 1
            assert {pb: "v"}[PriceBook(prices={"a": 1, "b": 2})] == "v"
            assert pb != PriceBook(prices={"a": 9})

            # Multi-field value object folds every field.
            c = Catalogue(name="book", prices={"a": 1})
            assert hash(c) == hash(Catalogue(name="book", prices={"a": 1}))
            assert c != Catalogue(name="other", prices={"a": 1})
            assert len({c}) == 1

            # Optional Map field, both present and absent.
            assert hash(MaybePrices(prices=None)) == hash(MaybePrices(prices=None))
            assert hash(MaybePrices(prices={"a": 1})) == hash(MaybePrices(prices={"a": 1}))
            assert MaybePrices(prices=None) != MaybePrices(prices={"a": 1})

            # #657 — Map nested inside a List: each element dict folds, so the tuple is hashable.
            bk = Buckets(rows=({"a": 1},))
            assert hash(bk) == hash(Buckets(rows=({"a": 1},)))
            assert len({bk, Buckets(rows=({"a": 1},))}) == 1
            assert bk != Buckets(rows=({"a": 2},))

            # #657 — Map whose value side is itself a Map: both levels fold.
            gr = Grid(cells={"a": {"b": 1}})
            assert hash(gr) == hash(Grid(cells={"a": {"b": 1}}))
            assert len({gr}) == 1
            assert gr != Grid(cells={"a": {"b": 2}})

            # #657 — deep Map<K, List<Map>>: fold at every level.
            ld = Ledger(by_key={"a": ({"b": 1},)})
            assert hash(ld) == hash(Ledger(by_key={"a": ({"b": 1},)}))
            assert ld != Ledger(by_key={"a": ({"b": 2},)})

            # #657 — optional nested Map, present and absent.
            assert hash(MaybeGrid(cells=None)) == hash(MaybeGrid(cells=None))
            assert hash(MaybeGrid(cells={"a": {"b": 1}})) == hash(MaybeGrid(cells={"a": {"b": 1}}))
            assert MaybeGrid(cells=None) != MaybeGrid(cells={"a": {"b": 1}})
            """;

        TestSupport.PythonCheck result = TestSupport.RunPython(Emit(), driver);
        TestSupport.RequireOrSkip(result.ToolchainAvailable, NoInterpreterNotice);

        result.Ok.ShouldBeTrue(string.Join("\n", result.Errors));
    }
}
