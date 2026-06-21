using System.Text.Json;
using Koine.Compiler.Ast;
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
