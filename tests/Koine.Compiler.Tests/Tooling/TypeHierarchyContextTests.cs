using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Context-aware type-hierarchy resolution (#389): a type's identity is <b>(context, name)</b>, not the
/// bare name. When the same name is declared in two bounded contexts (legal — each context is its own
/// namespace), <see cref="KoineLanguageService.Supertypes"/>/<see cref="KoineLanguageService.Subtypes"/>
/// must resolve edges within the cursor's enclosing context (and the model's cross-context visibility
/// rules), not conflate the two same-named types. Complements the dual-backend
/// <c>TypeHierarchyWireParityTests</c>.
/// </summary>
public class TypeHierarchyContextTests
{
    private static readonly KoineLanguageService Svc = new();

    // Two contexts each declaring `Money`: Billing.Invoice composes Billing.Money; Ordering.Order
    // composes Ordering.Money. With name-only matching, Subtypes(Money) wrongly returns BOTH Invoice
    // and Order; context-aware resolution must keep each Money's subtypes within its own context.
    private const string Uri = "file:///dup.koi";
    private const string Src =
        """
        context Billing {
          value Money { amount: Decimal }

          entity Invoice identified by InvoiceId {
            amount: Money
          }
        }

        context Ordering {
          value Money { amount: Decimal }

          entity Order identified by OrderId {
            total: Money
          }
        }
        """;

    private static KoineCompilation Compile() =>
        KoineCompilation.Create(new[] { new SourceFile(Uri, Src) });

    // The 0-based LSP line/character of `needle`, searched from the first occurrence of `after`, with
    // the cursor placed ONE column into the token (TokenLocator navigation is `[start, end]`).
    private static (int line, int character) PositionOf(string needle, string after)
    {
        var anchor = Src.IndexOf(after, StringComparison.Ordinal);
        var index = Src.IndexOf(needle, anchor, StringComparison.Ordinal) + 1;
        var line = 0;
        var lineStart = 0;
        for (var i = 0; i < index; i++)
        {
            if (Src[i] == '\n')
            {
                line++;
                lineStart = i + 1;
            }
        }

        return (line, index - lineStart);
    }

    private static TypeHierarchyItem PreparedMoney(KoineCompilation comp, string contextKeyword)
    {
        var (line, character) = PositionOf("Money", contextKeyword);
        return Svc.PrepareTypeHierarchy(comp, Uri, line, character).ShouldHaveSingleItem();
    }

    [Fact]
    public void Prepare_resolves_the_type_in_the_cursors_enclosing_context()
    {
        var comp = Compile();

        PreparedMoney(comp, "context Billing").Context.ShouldBe("Billing");
        PreparedMoney(comp, "context Ordering").Context.ShouldBe("Ordering");
    }

    [Fact]
    public void Subtypes_of_Billing_Money_stay_within_Billing()
    {
        var comp = Compile();
        var billingMoney = PreparedMoney(comp, "context Billing");

        var subs = Svc.Subtypes(comp, billingMoney);

        subs.Select(s => s.Name).ShouldBe(new[] { "Invoice" });
        subs.ShouldAllBe(s => s.Context == "Billing");
    }

    [Fact]
    public void Subtypes_of_Ordering_Money_stay_within_Ordering()
    {
        var comp = Compile();
        var orderingMoney = PreparedMoney(comp, "context Ordering");

        var subs = Svc.Subtypes(comp, orderingMoney);

        subs.Select(s => s.Name).ShouldBe(new[] { "Order" });
        subs.ShouldAllBe(s => s.Context == "Ordering");
    }

    [Fact]
    public void Supertypes_of_an_entity_resolve_its_own_contexts_value()
    {
        var comp = Compile();
        var (line, character) = PositionOf("Invoice", "entity Invoice");
        var invoice = Svc.PrepareTypeHierarchy(comp, Uri, line, character).ShouldHaveSingleItem();

        var supers = Svc.Supertypes(comp, invoice);

        // Invoice points at Billing's Money (and its InvoiceId), never Ordering's Money.
        supers.ShouldContain(s => s.Name == "Money" && s.Context == "Billing");
        supers.ShouldNotContain(s => s.Name == "Money" && s.Context == "Ordering");
    }
}
