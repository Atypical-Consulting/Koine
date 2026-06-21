using System.Text.Json;
using Koine.Compiler.Ast;
using Koine.Compiler.Diagnostics;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// The model→<c>.koi</c> round-trip seam (#91) — the validated foundation behind every Studio visual
/// editor. Covers the read paths (<see cref="ModelRoundTripService.ModelToJson"/> /
/// <see cref="ModelRoundTripService.MembersOf"/>), the validated <c>EmitKoine</c> write path, and the
/// scoped <c>ApplyEdit</c> patch.
/// </summary>
public class ModelRoundTripTests
{
    /// <summary>A small multi-context model exercising every node kind the seam projects.</summary>
    private const string Sample = """
        context Ordering {
          /// A monetary amount.
          value Money { amount: Decimal }

          enum OrderStatus { Draft, Placed, Shipped }

          integration event OrderPlaced {
            orderId: OrderId
            total: Decimal
          }

          aggregate Order root Order {
            value OrderLine {
              product:   ProductId
              quantity:  Int
              unitPrice: Decimal
              subtotal:  Decimal = unitPrice * quantity
            }

            entity Order identified by OrderId {
              lines:  List<OrderLine>
              status: OrderStatus = Draft

              states status {
                Draft  -> Placed
                Placed -> Shipped
              }
            }
          }
        }
        """;

    private static KoineModel Compile(string src) =>
        new KoineCompiler().Parse(new[] { new SourceFile("t.koi", src) }).Model!;

    private static readonly JsonSerializerOptions SnapshotJson = new()
    {
        WriteIndented = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    };

    // ---- Task 1: read paths ----------------------------------------------

    [Fact]
    public void ModelToJson_emits_a_node_per_declaration_with_stable_qualified_names()
    {
        ModelNode root = ModelRoundTripService.ModelToJson(Compile(Sample));

        root.Kind.ShouldBe("model");
        var qualifiedNames = Flatten(root).Select(n => n.QualifiedName).ToList();

        qualifiedNames.ShouldContain("Ordering");
        qualifiedNames.ShouldContain("Ordering.Money");
        qualifiedNames.ShouldContain("Ordering.OrderStatus");
        qualifiedNames.ShouldContain("Ordering.OrderPlaced");
        qualifiedNames.ShouldContain("Ordering.Order");                 // the aggregate
        qualifiedNames.ShouldContain("Ordering.Order.OrderLine");       // aggregate-nested value
        qualifiedNames.ShouldContain("Ordering.Order.Order");           // aggregate-nested entity
        qualifiedNames.ShouldContain("Ordering.Order.Order.states.status");
    }

    [Fact]
    public void ModelToJson_scoped_returns_just_the_subtree()
    {
        ModelNode node = ModelRoundTripService.ModelToJson(Compile(Sample), "Ordering.Money");

        node.Kind.ShouldBe("value");
        node.QualifiedName.ShouldBe("Ordering.Money");
        node.Members.Single().Name.ShouldBe("amount");
        node.Members.Single().Type.ShouldBe("Decimal");
    }

    [Fact]
    public void ModelToJson_unknown_name_yields_an_unknown_node()
    {
        ModelNode node = ModelRoundTripService.ModelToJson(Compile(Sample), "Nope.Missing");
        node.Kind.ShouldBe("unknown");
    }

    [Fact]
    public void MembersOf_lists_exactly_an_entitys_fields()
    {
        var members = ModelRoundTripService.MembersOf(Compile(Sample), "Ordering.Order.Order");

        members.Select(m => m.Name).ShouldBe(new[] { "lines", "status" });
        members[0].Type.ShouldBe("List<OrderLine>");
        members[1].Type.ShouldBe("OrderStatus");
        members[1].Value.ShouldBe("Draft");   // the initializer is surfaced as the current value
    }

    [Fact]
    public void MembersOf_lists_enum_members()
    {
        ModelRoundTripService.MembersOf(Compile(Sample), "Ordering.OrderStatus")
            .Select(m => m.Name)
            .ShouldBe(new[] { "Draft", "Placed", "Shipped" });
    }

    [Fact]
    public void MembersOf_lists_state_machine_transitions()
    {
        var transitions = ModelRoundTripService.MembersOf(Compile(Sample), "Ordering.Order.Order.states.status");

        transitions.ShouldAllBe(m => m.Kind == "transition");
        transitions.Single(t => t.Name == "Draft").Value.ShouldBe("Placed");
        transitions.Single(t => t.Name == "Placed").Value.ShouldBe("Shipped");
    }

    [Fact]
    public void MembersOf_unknown_name_is_empty()
    {
        ModelRoundTripService.MembersOf(Compile(Sample), "Nope").ShouldBeEmpty();
    }

    [Fact]
    public Task ModelToJson_serialises_the_ordering_starter_to_a_stable_contract()
    {
        var src = File.ReadAllText(TestSupport.RepoPath("templates/starters/ordering/ordering.koi"));
        ModelNode root = ModelRoundTripService.ModelToJson(Compile(src));
        var json = JsonSerializer.Serialize(root, SnapshotJson);
        return Verify(json).UseDirectory("Snapshots");
    }

    // ---- Task 2: EmitKoine (structured edit → validated canonical .koi) ----

    private static SourceFile[] Files(string src) => new[] { new SourceFile("t.koi", src) };

    [Fact]
    public void EmitKoine_is_idempotent_for_a_no_op_edit()
    {
        // Renaming a member to its own name is a no-op: the re-emitted declaration is the source one.
        var edit = new StructuredEdit(StructuredEditKind.RenameMember, "Ordering.Money.amount", Name: "amount");
        EmitResult result = ModelRoundTripService.EmitKoine(Files(Sample), edit);

        result.Diagnostics.ShouldBeEmpty();
        result.Koine!.ShouldBe("value Money { amount: Decimal }");
    }

    [Fact]
    public void EmitKoine_add_field_emits_the_new_field()
    {
        var edit = new StructuredEdit(StructuredEditKind.AddField, "Ordering.Money", Name: "tax", Type: "Decimal");
        EmitResult result = ModelRoundTripService.EmitKoine(Files(Sample), edit);

        result.Diagnostics.ShouldBeEmpty();
        result.Koine!.ShouldContain("tax: Decimal");
        result.Koine!.ShouldContain("amount: Decimal");   // existing field preserved
    }

    [Fact]
    public void EmitKoine_rename_emits_the_new_name()
    {
        var edit = new StructuredEdit(StructuredEditKind.RenameMember, "Ordering.Money.amount", Name: "value");
        EmitResult result = ModelRoundTripService.EmitKoine(Files(Sample), edit);

        result.Diagnostics.ShouldBeEmpty();
        result.Koine!.ShouldContain("value: Decimal");
    }

    [Fact]
    public void EmitKoine_illegal_type_change_returns_diagnostics_not_koine()
    {
        var edit = new StructuredEdit(StructuredEditKind.ChangeFieldType, "Ordering.Money.amount", Type: "Nope");
        EmitResult result = ModelRoundTripService.EmitKoine(Files(Sample), edit);

        result.Koine.ShouldBeNull();
        result.Diagnostics.ShouldContain(d => d.Code == Koine.Compiler.Diagnostics.DiagnosticCodes.UnknownType);
    }

    [Fact]
    public void EmitKoine_unresolved_target_is_a_no_op()
    {
        var edit = new StructuredEdit(StructuredEditKind.RenameMember, "Nope.Missing.field", Name: "x");
        EmitResult result = ModelRoundTripService.EmitKoine(Files(Sample), edit);

        result.Koine.ShouldBeNull();
        result.Diagnostics.ShouldBeEmpty();
    }

    [Fact]
    public void EmitKoine_remove_field_on_its_own_line_drops_just_that_line()
    {
        const string src = "context C {\n  value V {\n    a: Int\n    b: Int\n  }\n}\n";
        EmitResult result = ModelRoundTripService.EmitKoine(Files(src), new StructuredEdit(StructuredEditKind.RemoveMember, "C.V.a"));

        result.Diagnostics.ShouldBeEmpty();
        result.Koine!.ShouldNotContain("a: Int");
        result.Koine!.ShouldContain("b: Int");
    }

    [Fact]
    public void EmitKoine_remove_field_on_a_single_line_declaration_keeps_the_declaration()
    {
        // Regression: a member sharing its line with the braces must not take the whole declaration
        // (or the opening brace) down with it.
        const string src = "context C {\n  value Point { x: Int y: Int }\n}\n";
        EmitResult result = ModelRoundTripService.EmitKoine(Files(src), new StructuredEdit(StructuredEditKind.RemoveMember, "C.Point.x"));

        result.Diagnostics.ShouldBeEmpty();
        result.Koine!.ShouldContain("value Point");
        result.Koine!.ShouldContain("y: Int");
        result.Koine!.ShouldNotContain("x: Int");
    }

    [Fact]
    public void EmitKoine_add_field_keeps_a_trailing_comment_with_its_own_field()
    {
        const string src = "context C {\n  value Money {\n    amount: Decimal // the amount\n  }\n}\n";
        EmitResult result = ModelRoundTripService.EmitKoine(Files(src), new StructuredEdit(StructuredEditKind.AddField, "C.Money", Name: "tax", Type: "Decimal"));

        result.Diagnostics.ShouldBeEmpty();
        result.Koine!.ShouldContain("// the amount");
        result.Koine!.ShouldContain("tax: Decimal");
        // The comment stays with `amount` (before the new field), not stolen onto `tax`.
        result.Koine!.IndexOf("// the amount", StringComparison.Ordinal)
            .ShouldBeLessThan(result.Koine!.IndexOf("tax: Decimal", StringComparison.Ordinal));
    }

    [Fact]
    public void EmitKoine_add_transition_emits_the_rule()
    {
        var edit = new StructuredEdit(
            StructuredEditKind.AddTransition, "Ordering.Order.Order.states.status", Name: "Shipped", Type: "Placed");
        EmitResult result = ModelRoundTripService.EmitKoine(Files(Sample), edit);

        result.Diagnostics.ShouldBeEmpty();
        result.Koine!.ShouldContain("Shipped -> Placed");
    }

    // ---- Task 3: ApplyEdit (scoped TextEditModel patch) -------------------

    private static string Splice(string source, SourceSpan range, string replacement) =>
        source[..range.Offset] + replacement + source[(range.Offset + range.Length)..];

    [Fact]
    public void ApplyEdit_returns_a_single_scoped_patch_over_just_the_declaration()
    {
        var edit = new StructuredEdit(StructuredEditKind.AddField, "Ordering.Money", Name: "tax", Type: "Decimal");
        ModelEditResult result = ModelRoundTripService.ApplyEdit(Files(Sample), edit);

        result.Uri.ShouldBe("t.koi");
        result.Edits.Count.ShouldBe(1);

        var patched = Splice(Sample, result.Edits[0].Range, result.Edits[0].NewText);
        patched.ShouldContain("tax: Decimal");
        // Everything outside the edited declaration is byte-stable.
        patched.ShouldContain("enum OrderStatus { Draft, Placed, Shipped }");
        patched.ShouldContain("integration event OrderPlaced");
        // The patched buffer still compiles cleanly. The sample's aggregate is named after its root
        // (`aggregate Order root Order`), so it carries the orthogonal KOI0109 style warning — ignore
        // that here; this test asserts the edit introduced no NEW diagnostics.
        new KoineCompiler().Diagnose(patched)
            .Where(d => d.Code != DiagnosticCodes.AggregateNameMatchesRoot).ShouldBeEmpty();
    }

    [Fact]
    public void ApplyEdit_of_a_no_op_leaves_the_file_byte_stable()
    {
        var edit = new StructuredEdit(StructuredEditKind.RenameMember, "Ordering.Money.amount", Name: "amount");
        ModelEditResult result = ModelRoundTripService.ApplyEdit(Files(Sample), edit);

        result.Edits.Count.ShouldBe(1);
        Splice(Sample, result.Edits[0].Range, result.Edits[0].NewText).ShouldBe(Sample);
    }

    [Fact]
    public void ApplyEdit_illegal_edit_returns_no_patch_with_diagnostics()
    {
        var edit = new StructuredEdit(StructuredEditKind.ChangeFieldType, "Ordering.Money.amount", Type: "Nope");
        ModelEditResult result = ModelRoundTripService.ApplyEdit(Files(Sample), edit);

        result.Edits.ShouldBeEmpty();
        result.Diagnostics.ShouldNotBeEmpty();
    }

    private static IEnumerable<ModelNode> Flatten(ModelNode node)
    {
        yield return node;
        foreach (ModelNode child in node.Children)
        {
            foreach (ModelNode descendant in Flatten(child))
            {
                yield return descendant;
            }
        }
    }
}
