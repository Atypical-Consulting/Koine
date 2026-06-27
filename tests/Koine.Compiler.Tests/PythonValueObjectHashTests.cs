using Koine.Compiler.Emit;
using Koine.Compiler.Emit.Python;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Regression coverage for issue #612: a frozen Python value object that contains a <c>Map&lt;K,V&gt;</c>
/// field must stay hashable. A <c>Map</c> maps to a dict-backed <c>Mapping</c> (unhashable), so the
/// dataclass's free structural <c>__hash__</c> (from <c>frozen=True</c>) threw
/// <c>TypeError: unhashable type: 'dict'</c> the moment such a value object was hashed. The emitter now
/// emits <c>eq=False</c> plus explicit structural <c>__eq__</c>/<c>__hash__</c> that fold each Map field
/// into a <c>frozenset(items())</c>. These tests assert the emitted SHAPE (env-independent) and — when a
/// Python interpreter is present — actually EXECUTE the hashing (the runtime hazard mypy/ast can't see).
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
            """;

        TestSupport.PythonCheck result = TestSupport.RunPython(Emit(), driver);
        TestSupport.RequireOrSkip(result.ToolchainAvailable, NoInterpreterNotice);

        result.Ok.ShouldBeTrue(string.Join("\n", result.Errors));
    }
}
