using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Task 6: collision-checked + member-access-complete rename.
/// <list type="bullet">
/// <item>Renaming a type to the name of an EXISTING type (same namespace) is rejected.</item>
/// <item>A same-named ENUM MEMBER (different namespace) must NOT block a type rename.</item>
/// <item>A member rename now reaches the dotted selector in <c>receiver.member</c>.</item>
/// <item>Enum-member scope (Phase.Active vs State.Active) still holds — no regression.</item>
/// </list>
/// </summary>
public class RenameSafetyTests
{
    private static readonly KoineLanguageService Svc = new();
    private const string U = "file:///t.koi";

    private static IReadOnlyDictionary<string, string> Doc(string src) =>
        new Dictionary<string, string> { [U] = src };

    [Fact]
    public void Rename_of_a_type_to_an_existing_type_name_is_rejected()
    {
        // Renaming the type `Order` to `Customer`, where `Customer` is already a declared type, would
        // collide two types in the same namespace — reject (return null).
        var src =
            "context C {\n" +
            "  value Order { total: Decimal }\n" +
            "  value Customer { name: String }\n" +
            "}\n";
        // Cursor on the `Order` type declaration (line index 1, col 8 = the 'O').
        var col = src.Split('\n')[1].IndexOf("Order", StringComparison.Ordinal) + 1;
        Svc.RenameAt(Doc(src), U, line: 1, character: col, newName: "Customer").ShouldBeNull();
    }

    [Fact]
    public void Rename_of_a_type_is_not_blocked_by_a_same_named_enum_member()
    {
        // Renaming the type `Status` to `Foo` must NOT be blocked just because an unrelated enum has a
        // member also named `Status` — that member lives in a different namespace/kind.
        var src =
            "context C {\n" +
            "  enum Phase { Status, Done }\n" +
            "  value Status { x: Decimal }\n" +
            "  value Line { p: Status }\n" +
            "}\n";
        // Cursor on the `Status` TYPE declaration (line index 2).
        var col = src.Split('\n')[2].IndexOf("Status", StringComparison.Ordinal) + 1;
        var edits = Svc.RenameAt(Doc(src), U, line: 2, character: col, newName: "Foo");
        edits.ShouldNotBeNull();
        edits.ShouldContain(r => r.Line == 3); // the type declaration
        edits.ShouldContain(r => r.Line == 4); // the TypeRef use
        edits.ShouldNotContain(r => r.Line == 2); // the Phase enum member named Status
    }

    [Fact]
    public void Rename_of_a_member_rewrites_a_dotted_selector()
    {
        // `total.amount` references Money.amount through a receiver `total : Money`. Renaming the
        // member `amount` (on Money) must rewrite the `.amount` selector in `total.amount` too.
        var src =
            "context C {\n" +
            "  value Money { amount: Decimal }\n" +
            "  value Line {\n" +
            "    total: Money\n" +
            "    invariant total.amount >= 0\n" +
            "  }\n" +
            "}\n";
        // Cursor on the `amount` field declaration in Money (line index 1).
        var col = src.Split('\n')[1].IndexOf("amount", StringComparison.Ordinal) + 1;
        var edits = Svc.RenameAt(Doc(src), U, line: 1, character: col, newName: "value");
        edits.ShouldNotBeNull();
        edits.ShouldContain(r => r.Line == 2); // Money.amount declaration
        // The dotted selector occurrence: the `amount` inside `total.amount` on line 5 (1-based).
        var selector = src.Split('\n')[4].IndexOf(".amount", StringComparison.Ordinal) + 1; // 0-based col of 'a' in .amount
        edits.ShouldContain(r => r.Line == 5 && r.StartColumn == selector);
    }

    [Fact]
    public void Rename_of_an_enum_member_rewrites_a_qualified_selector_but_not_a_sibling_member()
    {
        // Renaming the `Cancelled` member of `RefundStatus` must rewrite both its declaration AND the
        // qualified `RefundStatus.Cancelled` selector in an expression — while a sibling enum's bare
        // `Cancelled` member must NOT be touched.
        var src =
            "context C {\n" +
            "  enum RefundStatus { Cancelled, Done }\n" +
            "  enum OtherStatus { Cancelled, Open }\n" +
            "  value Refund {\n" +
            "    status: RefundStatus\n" +
            "    isCancelled: Bool = status == RefundStatus.Cancelled\n" +
            "  }\n" +
            "}\n";
        // Cursor on the `Cancelled` member declaration in RefundStatus (line index 1).
        var col = src.Split('\n')[1].IndexOf("Cancelled", StringComparison.Ordinal) + 1;
        var edits = Svc.RenameAt(Doc(src), U, line: 1, character: col, newName: "Voided");
        edits.ShouldNotBeNull();
        edits.ShouldContain(r => r.Line == 2); // RefundStatus.Cancelled declaration
        // The qualified selector `RefundStatus.Cancelled` on line 6 (1-based).
        var selector = src.Split('\n')[5].IndexOf(".Cancelled", StringComparison.Ordinal) + 1; // 0-based col of 'C'
        edits.ShouldContain(r => r.Line == 6 && r.StartColumn == selector);
        edits.ShouldNotContain(r => r.Line == 3); // sibling OtherStatus.Cancelled untouched
    }

    [Fact]
    public void Rename_of_an_enum_member_stays_scoped_to_its_owning_enum()
    {
        // No-regression mirror: renaming Phase.Active must NOT cross into a sibling State.Active.
        var src =
            "context C {\n" +
            "  enum Phase { Active, Done }\n" +
            "  enum State { Active, Closed }\n" +
            "}\n";
        var edits = Svc.RenameAt(Doc(src), U, line: 1, character: 16, newName: "Running");
        edits.ShouldNotBeNull();
        edits.ShouldHaveSingleItem();
        edits.ShouldContain(r => r.Line == 2);     // Phase.Active
        edits.ShouldNotContain(r => r.Line == 3);  // State.Active untouched
    }
}
