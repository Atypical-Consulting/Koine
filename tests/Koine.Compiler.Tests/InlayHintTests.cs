using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Inlay hints in the language service (#260, Task 2). Two genuine sites in Koine's grammar:
/// a <c>Type</c> hint on a <em>direct</em> read-model field (its type is inferred from the
/// source member of the same name) and a <c>Parameter</c> hint before each positional argument
/// of a call whose callee resolves to a parameterized declaration.
/// </summary>
public class InlayHintTests
{
    private static readonly KoineLanguageService Svc = new();
    private const string U = "file:///t.koi";

    private static KoineCompilation Compile(string src) =>
        KoineCompilation.Create(new[] { new SourceFile(U, src) });

    // A read model whose direct fields `total` and `status` infer their types from `Order`.
    private const string ReadModelSrc =
        "context Sales {\n" +
        "  value Money { amount: Decimal currency: String }\n" +
        "  entity Order identified by OrderId { total: Money status: String }\n" +
        "  readmodel OrderRow from Order {\n" +
        "    total\n" +
        "    status\n" +
        "  }\n" +
        "}\n";

    // An operation that calls another operation positionally — the only un-labeled argument site
    // in Koine. (Parses clean; the call resolves to `cap(orderTotal, requested)`.)
    private const string CallSrc =
        "context Sales {\n" +
        "  service PriceService {\n" +
        "    operation cap(orderTotal: Decimal, requested: Decimal): Decimal =\n" +
        "      if requested > orderTotal then orderTotal else requested\n" +
        "    operation apply(base: Decimal): Decimal =\n" +
        "      PriceService.cap(base, base)\n" +
        "  }\n" +
        "}\n";

    [Fact]
    public void Type_hint_is_emitted_for_a_direct_read_model_field()
    {
        var comp = Compile(ReadModelSrc);
        var hints = Svc.InlayHintsAt(comp, U, 0, 0, 100, 0);

        // `total : Money` and `status : String` — inferred from the Order members.
        hints.ShouldContain(h => h.Kind == InlayHintKind.Type && h.Label == ": Money");
        hints.ShouldContain(h => h.Kind == InlayHintKind.Type && h.Label == ": String");

        // The `total` hint sits at the end of the field name token on its 0-based line (line 4 → 4).
        var totalHint = hints.First(h => h.Kind == InlayHintKind.Type && h.Label == ": Money");
        totalHint.Line.ShouldBe(4);
    }

    [Fact]
    public void Parameter_hints_are_emitted_for_positional_call_arguments()
    {
        var comp = Compile(CallSrc);
        var hints = Svc.InlayHintsAt(comp, U, 0, 0, 100, 0);

        // Both positional args resolve to cap's parameters, in order.
        hints.ShouldContain(h => h.Kind == InlayHintKind.Parameter && h.Label == "orderTotal:");
        hints.ShouldContain(h => h.Kind == InlayHintKind.Parameter && h.Label == "requested:");

        // The hints anchor on the call line (`PriceService.cap(base, base)` is line index 5).
        hints.Where(h => h.Kind == InlayHintKind.Parameter)
            .ShouldAllBe(h => h.Line == 5);
    }

    [Fact]
    public void Hints_outside_the_requested_range_are_excluded()
    {
        var comp = Compile(ReadModelSrc);

        // A narrow range covering only the `status` field line (index 5). The `total` hint on line 4
        // must be excluded; the `status` hint must remain.
        var hints = Svc.InlayHintsAt(comp, U, 5, 0, 5, 100);

        hints.ShouldContain(h => h.Kind == InlayHintKind.Type && h.Label == ": String");
        hints.ShouldNotContain(h => h.Label == ": Money");
    }
}
