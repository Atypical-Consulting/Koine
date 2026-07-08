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

    // ---- #1163: transition/command correlation + per-edge fan-out ---------

    /// <summary>
    /// A state machine exercising the four projection cases: a guarded edge a command drives
    /// (<c>Draft → Submitted</c>), an edge no command drives (<c>Submitted → Placed</c>), a single
    /// rule with two targets (<c>Placed → Shipped, Cancelled</c>), and a terminal state (<c>Paid</c>).
    /// </summary>
    private const string StateMachineSample = """
        context Sales {
          enum OrderStatus { Draft, Submitted, Placed, Shipped, Cancelled, Paid }
          entity Order identified by OrderId {
            status:          OrderStatus = Draft
            totalIsPositive: Bool

            states status {
              Draft     -> Submitted when totalIsPositive
              Submitted -> Placed
              Placed    -> Shipped, Cancelled
              Paid
            }

            command Submit { status -> Submitted }
          }
        }
        """;

    [Fact]
    public void MembersOf_correlates_the_triggering_command_with_a_transition()
    {
        var transitions = ModelRoundTripService.MembersOf(Compile(StateMachineSample), "Sales.Order.states.status");

        ModelMember draftToSubmitted = transitions.Single(t => t.Name == "Draft" && t.Value == "Submitted");
        draftToSubmitted.Via.ShouldBe("Submit");
        draftToSubmitted.Name.ShouldBe("Draft");
        draftToSubmitted.Value.ShouldBe("Submitted");
        draftToSubmitted.Type.ShouldBe("totalIsPositive");   // the guard, described target-agnostically
    }

    [Fact]
    public void MembersOf_omits_the_trigger_when_no_command_drives_the_edge_but_keeps_the_edge()
    {
        var transitions = ModelRoundTripService.MembersOf(Compile(StateMachineSample), "Sales.Order.states.status");

        ModelMember submittedToPlaced = transitions.Single(t => t.Name == "Submitted" && t.Value == "Placed");
        submittedToPlaced.Via.ShouldBeNull();
    }

    [Fact]
    public void MembersOf_fans_a_multi_target_rule_out_to_one_member_per_edge()
    {
        var transitions = ModelRoundTripService.MembersOf(Compile(StateMachineSample), "Sales.Order.states.status");

        transitions.Where(t => t.Name == "Placed").Select(t => t.Value).ShouldBe(new[] { "Shipped", "Cancelled" });
    }

    [Fact]
    public void MembersOf_omits_a_terminal_state_with_no_outgoing_edge()
    {
        var transitions = ModelRoundTripService.MembersOf(Compile(StateMachineSample), "Sales.Order.states.status");

        transitions.ShouldNotContain(t => t.Name == "Paid");
    }

    // ---- #1163 (Task 2): per-edge transitions surfaced on the owning entity node ------------------

    [Fact]
    public void ModelToJson_exposes_transitions_directly_on_the_owning_entity_node()
    {
        ModelNode order = ModelRoundTripService.ModelToJson(Compile(StateMachineSample), "Sales.Order");

        // The owner node itself lists the flattened per-edge transitions (not only the nested `states`
        // child): Draft→Submitted, Submitted→Placed, Placed→Shipped, Placed→Cancelled = 4 edges;
        // the terminal `Paid` contributes none.
        order.Kind.ShouldBe("entity");
        order.Transitions.Count.ShouldBe(4);
        order.Transitions.ShouldAllBe(t => t.Kind == "transition");
    }

    [Fact]
    public void ModelToJson_owner_transitions_carry_the_guard_and_triggering_command()
    {
        ModelNode order = ModelRoundTripService.ModelToJson(Compile(StateMachineSample), "Sales.Order");

        ModelMember draftToSubmitted = order.Transitions.Single(t => t.Name == "Draft" && t.Value == "Submitted");
        draftToSubmitted.Via.ShouldBe("Submit");
        draftToSubmitted.Type.ShouldBe("totalIsPositive");   // the guard, described target-agnostically
    }

    [Fact]
    public void ModelToJson_a_node_with_no_state_machine_has_an_empty_transitions_list()
    {
        ModelNode enumNode = ModelRoundTripService.ModelToJson(Compile(StateMachineSample), "Sales.OrderStatus");
        ModelNode context = ModelRoundTripService.ModelToJson(Compile(StateMachineSample), "Sales");

        enumNode.Transitions.ShouldNotBeNull();
        enumNode.Transitions.ShouldBeEmpty();
        context.Transitions.ShouldBeEmpty();
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
    public void EmitKoine_change_field_type_emits_the_new_type()
    {
        var edit = new StructuredEdit(StructuredEditKind.ChangeFieldType, "Ordering.Money.amount", Type: "Int");
        EmitResult result = ModelRoundTripService.EmitKoine(Files(Sample), edit);

        result.Diagnostics.ShouldBeEmpty();
        result.Koine!.ShouldContain("amount: Int");
    }

    [Fact]
    public void EmitKoine_illegal_type_change_returns_diagnostics_not_koine()
    {
        var edit = new StructuredEdit(StructuredEditKind.ChangeFieldType, "Ordering.Money.amount", Type: "Nope");
        EmitResult result = ModelRoundTripService.EmitKoine(Files(Sample), edit);

        result.Koine.ShouldBeNull();
        result.Diagnostics.ShouldContain(d => d.Code == DiagnosticCodes.UnknownType);
    }

    // ---- Changing an entity's identity via its synthetic `id` row (the Properties panel) -------------

    [Fact]
    public void EmitKoine_change_entity_id_to_a_primitive_adds_a_natural_strategy()
    {
        const string src = "context C {\n  entity Product identified by ProductId { sku: String }\n}\n";
        var edit = new StructuredEdit(StructuredEditKind.ChangeFieldType, "C.Product.id", Type: "Int");
        EmitResult result = ModelRoundTripService.EmitKoine(Files(src), edit);

        result.Diagnostics.ShouldBeEmpty();
        result.Koine!.ShouldContain("identified by ProductId as natural(Int)");
    }

    [Fact]
    public void EmitKoine_change_entity_id_replaces_an_existing_strategy()
    {
        const string src = "context C {\n  entity Product identified by ProductId as natural(Int) { sku: String }\n}\n";
        var edit = new StructuredEdit(StructuredEditKind.ChangeFieldType, "C.Product.id", Type: "String");
        EmitResult result = ModelRoundTripService.EmitKoine(Files(src), edit);

        result.Diagnostics.ShouldBeEmpty();
        result.Koine!.ShouldContain("identified by ProductId as natural(String)");
        result.Koine!.ShouldNotContain("natural(Int)");
    }

    [Fact]
    public void EmitKoine_change_entity_id_to_a_non_primitive_renames_the_id_type()
    {
        const string src = "context C {\n  entity Product identified by ProductId { sku: String }\n}\n";
        var edit = new StructuredEdit(StructuredEditKind.ChangeFieldType, "C.Product.id", Type: "CatalogId");
        EmitResult result = ModelRoundTripService.EmitKoine(Files(src), edit);

        result.Diagnostics.ShouldBeEmpty();
        result.Koine!.ShouldContain("identified by CatalogId");
        result.Koine!.ShouldNotContain("as natural");
    }

    [Fact]
    public void EmitKoine_change_entity_id_to_an_unsupported_primitive_is_rejected_with_a_diagnostic()
    {
        const string src = "context C {\n  entity Product identified by ProductId { sku: String }\n}\n";
        var edit = new StructuredEdit(StructuredEditKind.ChangeFieldType, "C.Product.id", Type: "Decimal");
        EmitResult result = ModelRoundTripService.EmitKoine(Files(src), edit);

        result.Koine.ShouldBeNull();
        result.Diagnostics.ShouldContain(d => d.Code == DiagnosticCodes.NaturalIdBackingType);
    }

    [Fact]
    public void EmitKoine_change_aggregate_root_id_targets_the_root_entitys_identity()
    {
        // The diagram addresses an aggregate root by the aggregate qname; the id row resolves to the root.
        var edit = new StructuredEdit(StructuredEditKind.ChangeFieldType, "Ordering.Order.id", Type: "Int");
        EmitResult result = ModelRoundTripService.EmitKoine(Files(Sample), edit);

        result.Diagnostics.ShouldBeEmpty();
        result.Koine!.ShouldContain("identified by OrderId as natural(Int)");
    }

    [Fact]
    public void EmitKoine_change_entity_id_in_the_studio_default_billing_model()
    {
        // Reproduces the exact Studio default workspace after "Add Entity" appends NewEntity, then the
        // Properties panel changes the id type to Int (the user-reported "Edit rejected" scenario).
        const string src = """
            context Billing {
              value Money {
                amount: Decimal
                currency: Currency
                invariant amount >= 0        "a monetary amount cannot be negative"
              }
              enum Currency { EUR, USD, GBP }
              value Email {
                raw: String
                invariant raw matches /^[^@]+@[^@]+$/   "invalid email address"
              }
              entity Customer identified by CustomerId {
                name: String
                email: Email
              }
              aggregate Order root Order {
                enum OrderStatus { Draft, Placed, Shipped, Cancelled }
                value OrderLine {
                  product:   ProductId
                  quantity:  Int
                  unitPrice: Money
                  subtotal:  Money = unitPrice * quantity
                }
                entity Order identified by OrderId {
                  customer: CustomerId
                  lines:    List<OrderLine>
                  status:   OrderStatus = Draft
                  invariant status == Draft when lines.isEmpty
                }
              }

              entity NewEntity identified by NewEntityId {
                name: String
              }
            }
            """;
        var edit = new StructuredEdit(StructuredEditKind.ChangeFieldType, "Billing.NewEntity.id", Type: "Int");
        EmitResult result = ModelRoundTripService.EmitKoine(Files(src), edit);

        result.Diagnostics.ShouldBeEmpty();
        result.Koine!.ShouldContain("identified by NewEntityId as natural(Int)");
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

    // ---- add / remove whole types (authoring: add / delete a node) --------

    [Fact]
    public void EmitKoine_add_type_emits_a_new_value_skeleton_in_the_context()
    {
        var edit = new StructuredEdit(StructuredEditKind.AddType, "Ordering", Name: "Discount");
        EmitResult result = ModelRoundTripService.EmitKoine(Files(Sample), edit);

        result.Diagnostics.ShouldBeEmpty();
        result.Koine.ShouldNotBeNull();
        result.Koine!.ShouldContain("value Discount");
        result.Koine!.ShouldContain("name: String");
        // The whole context is re-emitted, so the existing types survive alongside the new one.
        result.Koine!.ShouldContain("value Money");
    }

    [Fact]
    public void EmitKoine_add_type_with_a_duplicate_name_is_rejected()
    {
        var edit = new StructuredEdit(StructuredEditKind.AddType, "Ordering", Name: "Money");
        EmitResult result = ModelRoundTripService.EmitKoine(Files(Sample), edit);

        result.Koine.ShouldBeNull();
        result.Diagnostics.ShouldNotBeEmpty();
    }

    [Fact]
    public void EmitKoine_add_type_to_an_unknown_context_is_a_no_op()
    {
        var edit = new StructuredEdit(StructuredEditKind.AddType, "Nope", Name: "Foo");
        EmitResult result = ModelRoundTripService.EmitKoine(Files(Sample), edit);

        result.Koine.ShouldBeNull();
    }

    [Fact]
    public void EmitKoine_add_entity_emits_an_identified_entity_skeleton()
    {
        var edit = new StructuredEdit(StructuredEditKind.AddType, "Ordering", Name: "Customer", Type: "entity");
        EmitResult result = ModelRoundTripService.EmitKoine(Files(Sample), edit);

        result.Diagnostics.ShouldBeEmpty();
        result.Koine.ShouldNotBeNull();
        result.Koine!.ShouldContain("entity Customer identified by CustomerId");
    }

    [Fact]
    public void EmitKoine_add_event_emits_an_event_skeleton()
    {
        var edit = new StructuredEdit(StructuredEditKind.AddType, "Ordering", Name: "OrderShipped", Type: "event");
        EmitResult result = ModelRoundTripService.EmitKoine(Files(Sample), edit);

        result.Diagnostics.ShouldBeEmpty();
        result.Koine!.ShouldContain("event OrderShipped");
    }

    [Fact]
    public void EmitKoine_add_enum_emits_an_enum_skeleton()
    {
        var edit = new StructuredEdit(StructuredEditKind.AddType, "Ordering", Name: "Priority", Type: "enum");
        EmitResult result = ModelRoundTripService.EmitKoine(Files(Sample), edit);

        result.Diagnostics.ShouldBeEmpty();
        result.Koine!.ShouldContain("enum Priority");
    }

    [Fact]
    public void EmitKoine_add_aggregate_emits_a_self_contained_aggregate_with_a_root_entity()
    {
        var edit = new StructuredEdit(StructuredEditKind.AddType, "Ordering", Name: "Shipment", Type: "aggregate");
        EmitResult result = ModelRoundTripService.EmitKoine(Files(Sample), edit);

        result.Diagnostics.ShouldBeEmpty();
        result.Koine!.ShouldContain("aggregate Shipment root ShipmentRoot");
        result.Koine!.ShouldContain("entity ShipmentRoot identified by ShipmentRootId");
    }

    [Fact]
    public void EmitKoine_add_service_emits_a_service_skeleton()
    {
        var edit = new StructuredEdit(StructuredEditKind.AddType, "Ordering", Name: "Checkout", Type: "service");
        EmitResult result = ModelRoundTripService.EmitKoine(Files(Sample), edit);

        result.Diagnostics.ShouldBeEmpty();
        result.Koine.ShouldNotBeNull();
        result.Koine!.ShouldContain("service Checkout");
        // A minimal usecase keeps the service non-empty and self-contained so the round-trip re-validates.
        result.Koine!.ShouldContain("usecase");
    }

    [Fact]
    public void EmitKoine_add_type_with_null_kind_still_emits_a_value_skeleton()
    {
        // Back-compat: the old bare "+" button sends no Type.
        var edit = new StructuredEdit(StructuredEditKind.AddType, "Ordering", Name: "Discount");
        EmitResult result = ModelRoundTripService.EmitKoine(Files(Sample), edit);

        result.Koine!.ShouldContain("value Discount");
    }

    [Fact]
    public void ApplyEdit_add_entity_yields_a_compiling_model()
    {
        var edit = new StructuredEdit(StructuredEditKind.AddType, "Ordering", Name: "Customer", Type: "entity");
        ModelEditResult result = ModelRoundTripService.ApplyEdit(Files(Sample), edit);

        result.Edits.Count.ShouldBe(1);
        result.Diagnostics.ShouldBeEmpty();
        var edited = Splice(Sample, result.Edits[0].Range, result.Edits[0].NewText);
        var (model, diags) = new KoineCompiler().Parse(new[] { new SourceFile("t.koi", edited) });
        diags.Where(d => d.Severity == DiagnosticSeverity.Error).ShouldBeEmpty();
        model.ShouldNotBeNull();
    }

    [Fact]
    public void ApplyEdit_add_aggregate_yields_a_compiling_model()
    {
        var edit = new StructuredEdit(StructuredEditKind.AddType, "Ordering", Name: "Shipment", Type: "aggregate");
        ModelEditResult result = ModelRoundTripService.ApplyEdit(Files(Sample), edit);

        result.Diagnostics.ShouldBeEmpty();
        result.Edits.Count.ShouldBe(1);
        var edited = Splice(Sample, result.Edits[0].Range, result.Edits[0].NewText);
        var (model, diags) = new KoineCompiler().Parse(new[] { new SourceFile("t.koi", edited) });
        diags.Where(d => d.Severity == DiagnosticSeverity.Error).ShouldBeEmpty();
        model.ShouldNotBeNull();
    }

    [Fact]
    public void ApplyEdit_add_service_yields_a_compiling_model()
    {
        var edit = new StructuredEdit(StructuredEditKind.AddType, "Ordering", Name: "Checkout", Type: "service");
        ModelEditResult result = ModelRoundTripService.ApplyEdit(Files(Sample), edit);

        result.Diagnostics.ShouldBeEmpty();
        result.Edits.Count.ShouldBe(1);
        var edited = Splice(Sample, result.Edits[0].Range, result.Edits[0].NewText);
        var (model, diags) = new KoineCompiler().Parse(new[] { new SourceFile("t.koi", edited) });
        diags.Where(d => d.Severity == DiagnosticSeverity.Error).ShouldBeEmpty();
        model.ShouldNotBeNull();
    }

    // ---- #254: aggregate-scoped members (repository / rule) ----------------

    [Fact]
    public void EmitKoine_add_repository_emits_a_repository_block_in_the_aggregate()
    {
        var edit = new StructuredEdit(StructuredEditKind.AddAggregateMember, "Ordering.Order", Type: "repository");
        EmitResult result = ModelRoundTripService.EmitKoine(Files(Sample), edit);

        result.Diagnostics.ShouldBeEmpty();
        result.Koine.ShouldNotBeNull();
        result.Koine!.ShouldContain("repository {");
        result.Koine!.ShouldContain("operations: add, getById");
        // The whole aggregate is re-emitted, so its root entity survives alongside the new repository.
        result.Koine!.ShouldContain("aggregate Order root Order");
        result.Koine!.ShouldContain("entity Order identified by OrderId");
    }

    [Fact]
    public void EmitKoine_add_rule_emits_an_aggregate_scoped_spec_over_the_root()
    {
        var edit = new StructuredEdit(StructuredEditKind.AddAggregateMember, "Ordering.Order", Name: "IsLarge", Type: "rule");
        EmitResult result = ModelRoundTripService.EmitKoine(Files(Sample), edit);

        result.Diagnostics.ShouldBeEmpty();
        result.Koine.ShouldNotBeNull();
        result.Koine!.ShouldContain("spec IsLarge on Order = true");
    }

    [Fact]
    public void EmitKoine_add_a_second_repository_is_refused()
    {
        // An aggregate holds at most one repository; a second insert is a no-op, not a double block.
        var src = """
            context Sales {
              aggregate Orders root Order {
                entity Order identified by OrderId {
                  total: Decimal
                }

                repository {
                  operations: getById, add
                }
              }
            }
            """;
        var edit = new StructuredEdit(StructuredEditKind.AddAggregateMember, "Sales.Orders", Type: "repository");
        EmitResult result = ModelRoundTripService.EmitKoine(Files(src), edit);

        result.Koine.ShouldBeNull();
    }

    [Fact]
    public void EmitKoine_add_rule_with_a_duplicate_name_is_rejected()
    {
        var src = """
            context Sales {
              aggregate Orders root Order {
                entity Order identified by OrderId {
                  total: Decimal
                }

                spec IsLarge on Order = true
              }
            }
            """;
        var edit = new StructuredEdit(StructuredEditKind.AddAggregateMember, "Sales.Orders", Name: "IsLarge", Type: "rule");
        EmitResult result = ModelRoundTripService.EmitKoine(Files(src), edit);

        result.Koine.ShouldBeNull();
        result.Diagnostics.ShouldNotBeEmpty();
    }

    [Fact]
    public void EmitKoine_add_aggregate_member_to_a_non_aggregate_target_is_a_no_op()
    {
        // Ordering.Money is a value object, not an aggregate — the edit resolves nothing.
        var edit = new StructuredEdit(StructuredEditKind.AddAggregateMember, "Ordering.Money", Type: "repository");
        EmitResult result = ModelRoundTripService.EmitKoine(Files(Sample), edit);

        result.Koine.ShouldBeNull();
    }

    [Fact]
    public void ApplyEdit_add_repository_yields_a_compiling_model()
    {
        var edit = new StructuredEdit(StructuredEditKind.AddAggregateMember, "Ordering.Order", Type: "repository");
        ModelEditResult result = ModelRoundTripService.ApplyEdit(Files(Sample), edit);

        result.Diagnostics.ShouldBeEmpty();
        result.Edits.Count.ShouldBe(1);
        var edited = Splice(Sample, result.Edits[0].Range, result.Edits[0].NewText);
        var (model, diags) = new KoineCompiler().Parse(new[] { new SourceFile("t.koi", edited) });
        diags.Where(d => d.Severity == DiagnosticSeverity.Error).ShouldBeEmpty();
        model.ShouldNotBeNull();
    }

    [Fact]
    public void ApplyEdit_add_rule_yields_a_compiling_model()
    {
        var edit = new StructuredEdit(StructuredEditKind.AddAggregateMember, "Ordering.Order", Name: "IsLarge", Type: "rule");
        ModelEditResult result = ModelRoundTripService.ApplyEdit(Files(Sample), edit);

        result.Diagnostics.ShouldBeEmpty();
        result.Edits.Count.ShouldBe(1);
        var edited = Splice(Sample, result.Edits[0].Range, result.Edits[0].NewText);
        var (model, diags) = new KoineCompiler().Parse(new[] { new SourceFile("t.koi", edited) });
        diags.Where(d => d.Severity == DiagnosticSeverity.Error).ShouldBeEmpty();
        model.ShouldNotBeNull();
    }

    // A compact aggregate whose closing brace shares a line with the last member's end (`} }`). The member
    // must still land INSIDE the aggregate: anchoring on end-of-line would push it past the aggregate's
    // brace, where a `spec` would re-home to context scope, re-validate, and leave the re-sliced aggregate
    // unchanged — a silent success that drops the rule.
    private const string CompactAggregate =
        "context S { aggregate Orders root Order { entity Order identified by OrderId { total: Int } } }";

    [Fact]
    public void EmitKoine_add_rule_into_a_compact_aggregate_lands_inside_it_not_dropped()
    {
        var edit = new StructuredEdit(StructuredEditKind.AddAggregateMember, "S.Orders", Name: "IsBig", Type: "rule");
        EmitResult result = ModelRoundTripService.EmitKoine(Files(CompactAggregate), edit);

        result.Diagnostics.ShouldBeEmpty();
        result.Koine.ShouldNotBeNull();
        // The re-emitted text is the AGGREGATE declaration; the spec appearing in it proves it nested inside.
        result.Koine!.ShouldContain("spec IsBig on Order = true");
    }

    [Fact]
    public void EmitKoine_add_repository_into_a_compact_aggregate_lands_inside_it()
    {
        var edit = new StructuredEdit(StructuredEditKind.AddAggregateMember, "S.Orders", Type: "repository");
        EmitResult result = ModelRoundTripService.EmitKoine(Files(CompactAggregate), edit);

        result.Diagnostics.ShouldBeEmpty();
        result.Koine.ShouldNotBeNull();
        result.Koine!.ShouldContain("repository {");
    }

    [Fact]
    public void ApplyEdit_add_rule_into_a_compact_aggregate_yields_a_compiling_model()
    {
        var edit = new StructuredEdit(StructuredEditKind.AddAggregateMember, "S.Orders", Name: "IsBig", Type: "rule");
        ModelEditResult result = ModelRoundTripService.ApplyEdit(Files(CompactAggregate), edit);

        result.Diagnostics.ShouldBeEmpty();
        result.Edits.Count.ShouldBe(1);
        var edited = Splice(CompactAggregate, result.Edits[0].Range, result.Edits[0].NewText);
        var (model, diags) = new KoineCompiler().Parse(new[] { new SourceFile("t.koi", edited) });
        diags.Where(d => d.Severity == DiagnosticSeverity.Error).ShouldBeEmpty();
        model.ShouldNotBeNull();
    }

    [Fact]
    public void EmitKoine_remove_type_drops_an_unreferenced_type()
    {
        var edit = new StructuredEdit(StructuredEditKind.RemoveType, "Ordering.Money");
        EmitResult result = ModelRoundTripService.EmitKoine(Files(Sample), edit);

        result.Diagnostics.ShouldBeEmpty();
        result.Koine.ShouldNotBeNull();
        result.Koine!.ShouldNotContain("value Money");
        // Other declarations stay.
        result.Koine!.ShouldContain("enum OrderStatus");
    }

    [Fact]
    public void EmitKoine_remove_a_referenced_type_is_rejected()
    {
        // OrderStatus is referenced by `status: OrderStatus`, so removing it must not yield a broken model.
        var edit = new StructuredEdit(StructuredEditKind.RemoveType, "Ordering.OrderStatus");
        EmitResult result = ModelRoundTripService.EmitKoine(Files(Sample), edit);

        result.Koine.ShouldBeNull();
        result.Diagnostics.ShouldNotBeEmpty();
    }

    [Fact]
    public void ApplyEdit_add_type_returns_one_patch_that_yields_a_compiling_model()
    {
        var edit = new StructuredEdit(StructuredEditKind.AddType, "Ordering", Name: "Discount");
        ModelEditResult result = ModelRoundTripService.ApplyEdit(Files(Sample), edit);

        result.Edits.Count.ShouldBe(1);
        result.Diagnostics.ShouldBeEmpty();

        var edited = Splice(Sample, result.Edits[0].Range, result.Edits[0].NewText);
        edited.ShouldContain("value Discount");
        var (model, diags) = new KoineCompiler().Parse(new[] { new SourceFile("t.koi", edited) });
        diags.Where(d => d.Severity == DiagnosticSeverity.Error).ShouldBeEmpty();
        model.ShouldNotBeNull();
    }

    [Fact]
    public void ApplyEdit_remove_type_yields_a_compiling_model_without_the_type()
    {
        var edit = new StructuredEdit(StructuredEditKind.RemoveType, "Ordering.Money");
        ModelEditResult result = ModelRoundTripService.ApplyEdit(Files(Sample), edit);

        result.Edits.Count.ShouldBe(1);
        var edited = Splice(Sample, result.Edits[0].Range, result.Edits[0].NewText);
        edited.ShouldNotContain("value Money");
        var (_, diags) = new KoineCompiler().Parse(new[] { new SourceFile("t.koi", edited) });
        diags.Where(d => d.Severity == DiagnosticSeverity.Error).ShouldBeEmpty();
    }

    // ---- diagram-addressed field edits resolve aggregates + nested types --
    // The Studio canvas addresses a node by its DIAGRAM qualified name: an aggregate root by the
    // aggregate's qname (e.g. "Sales.Cart") and a nested type by "Context.SimpleName" (dropping the
    // aggregate segment). These exercise that the edit pipeline resolves those forms to the right
    // declaration — an aggregate's fields living on its root entity, a nested type by simple name.

    private const string AggSample = """
        context Sales {
          value Money { amount: Decimal }

          aggregate Cart root Cart {
            value CartLine { sku: String }

            entity Cart identified by CartId {
              lines: List<CartLine>
              total: Money
              note:  String
            }
          }
        }
        """;

    [Fact]
    public void EmitKoine_add_field_to_an_aggregate_targets_its_root_entity()
    {
        // The diagram's aggregate-root node is addressed by the aggregate qname; the field must land on
        // the root entity (where the aggregate's fields live), not be rejected.
        var edit = new StructuredEdit(StructuredEditKind.AddField, "Sales.Cart", Name: "memo", Type: "String");
        EmitResult result = ModelRoundTripService.EmitKoine(Files(AggSample), edit);

        result.Diagnostics.ShouldBeEmpty();
        result.Koine.ShouldNotBeNull();
        result.Koine!.ShouldContain("memo: String");
    }

    [Fact]
    public void EmitKoine_add_field_to_a_nested_type_addressed_by_its_diagram_name()
    {
        // The diagram addresses the nested CartLine as "Sales.CartLine" (no aggregate segment).
        var edit = new StructuredEdit(StructuredEditKind.AddField, "Sales.CartLine", Name: "qty", Type: "Int");
        EmitResult result = ModelRoundTripService.EmitKoine(Files(AggSample), edit);

        result.Diagnostics.ShouldBeEmpty();
        result.Koine.ShouldNotBeNull();
        result.Koine!.ShouldContain("qty: Int");
    }

    [Fact]
    public void EmitKoine_remove_member_resolves_an_aggregate_owner_to_its_root_entity()
    {
        // A composition edge's backingMember is "Sales.Cart.note"; its owner "Sales.Cart" is the
        // aggregate, but the field lives on the root entity — the disconnect gesture relies on this.
        var edit = new StructuredEdit(StructuredEditKind.RemoveMember, "Sales.Cart.note");
        EmitResult result = ModelRoundTripService.EmitKoine(Files(AggSample), edit);

        result.Diagnostics.ShouldBeEmpty();
        result.Koine.ShouldNotBeNull();
        result.Koine!.ShouldNotContain("note:");
    }

    [Fact]
    public void EmitKoine_remove_type_addressed_by_its_diagram_name_drops_the_nested_type()
    {
        // Drop the only reference (`lines`) first so removal is legal, then remove the now-unreferenced
        // nested CartLine by its DIAGRAM name "Sales.CartLine" (no aggregate segment).
        ModelEditResult patch = ModelRoundTripService.ApplyEdit(
            Files(AggSample), new StructuredEdit(StructuredEditKind.RemoveMember, "Sales.Cart.lines"));
        patch.Edits.Count.ShouldBe(1);
        var withoutLines = Splice(AggSample, patch.Edits[0].Range, patch.Edits[0].NewText);

        EmitResult result = ModelRoundTripService.EmitKoine(
            Files(withoutLines), new StructuredEdit(StructuredEditKind.RemoveType, "Sales.CartLine"));

        result.Diagnostics.ShouldBeEmpty();
        result.Koine.ShouldNotBeNull();
        result.Koine!.ShouldNotContain("value CartLine");
    }

    [Fact]
    public void EmitKoine_remove_type_also_removes_its_leading_doc_comment()
    {
        // Money carries a `/// A monetary amount.` line; removing the type must take the doc with it so it
        // doesn't reattach to the following declaration.
        var edit = new StructuredEdit(StructuredEditKind.RemoveType, "Ordering.Money");
        EmitResult result = ModelRoundTripService.EmitKoine(Files(Sample), edit);

        result.Diagnostics.ShouldBeEmpty();
        result.Koine.ShouldNotBeNull();
        result.Koine!.ShouldNotContain("value Money");
        result.Koine!.ShouldNotContain("A monetary amount");
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
