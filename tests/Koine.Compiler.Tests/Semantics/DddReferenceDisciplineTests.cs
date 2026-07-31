using Koine.Compiler.Diagnostics;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Issue #296 — DDD reference discipline. The semantic validator must reject models in which a
/// building block holds a reference it shouldn't: a value object embedding an entity/aggregate
/// (KOI1601), an entity/aggregate referencing another aggregate directly instead of by Id (KOI1602),
/// a command/factory parameter typed as an entity/aggregate (KOI1603), or a domain-event field typed
/// as an entity/aggregate (KOI1604). Issue #300 closes the remaining gap: an entity/aggregate-root
/// member typed as a domain/integration event, read model, or query (KOI1605).
/// </summary>
public class DddReferenceDisciplineTests
{
    private static IReadOnlyList<Diagnostic> Diagnose(string source) => new KoineCompiler().Diagnose(source);

    // ---- KOI1601: value objects may not reference entities/aggregates ------

    [Fact]
    public void A_value_object_field_referencing_an_entity_is_reported()
    {
        const string src = """
            context Sales {
              entity Order identified by OrderId {
                total: Decimal
              }
              value OrderSummary {
                order: Order
                note:  String
              }
            }
            """;

        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.ValueObjectReferencesEntity);
    }

    [Fact]
    public void A_value_object_of_value_objects_and_enums_is_clean()
    {
        const string src = """
            context Sales {
              enum Currency { EUR, USD }
              value Money {
                amount:   Decimal
                currency: Currency
              }
              value Price {
                net:   Money
                label: String
              }
            }
            """;

        Diagnose(src).ShouldNotContain(d => d.Code == DiagnosticCodes.ValueObjectReferencesEntity);
    }

    [Fact]
    public void A_value_object_collection_of_entities_is_reported()
    {
        const string src = """
            context Sales {
              entity Order identified by OrderId {
                total: Decimal
              }
              value Basket {
                orders: List<Order>
              }
            }
            """;

        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.ValueObjectReferencesEntity);
    }

    // ---- KOI1604: domain events carry data and identities, not entities ----

    [Fact]
    public void A_domain_event_field_referencing_an_entity_is_reported()
    {
        const string src = """
            context Sales {
              entity Order identified by OrderId {
                total: Decimal
              }
              event OrderShipped {
                order: Order
              }
            }
            """;

        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.DomainEventReferencesEntity);
    }

    [Fact]
    public void A_domain_event_referencing_by_id_is_clean()
    {
        const string src = """
            context Sales {
              entity Order identified by OrderId {
                total: Decimal
              }
              event OrderShipped {
                order: OrderId
              }
            }
            """;

        Diagnose(src).ShouldNotContain(d => d.Code == DiagnosticCodes.DomainEventReferencesEntity);
    }

    // ---- KOI1603: command/factory parameters carry data and identities -----

    [Fact]
    public void A_command_parameter_typed_as_an_entity_is_reported()
    {
        const string src = """
            context Sales {
              entity Customer identified by CustomerId {
                name: String
              }
              entity Order identified by OrderId {
                total: Decimal
                command assign(customer: Customer) {
                  requires total > 0   "must have a total"
                }
              }
            }
            """;

        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.CommandParameterReferencesEntity);
    }

    [Fact]
    public void A_command_parameter_typed_as_an_id_is_clean()
    {
        const string src = """
            context Sales {
              entity Customer identified by CustomerId {
                name: String
              }
              entity Order identified by OrderId {
                total: Decimal
                command assign(customer: CustomerId) {
                  requires total > 0   "must have a total"
                }
              }
            }
            """;

        Diagnose(src).ShouldNotContain(d => d.Code == DiagnosticCodes.CommandParameterReferencesEntity);
    }

    [Fact]
    public void A_factory_parameter_typed_as_an_entity_is_reported()
    {
        const string src = """
            context Sales {
              entity Customer identified by CustomerId {
                name: String
              }
              entity Order identified by OrderId {
                total: Decimal
                create newOrder(customer: Customer) {
                }
              }
            }
            """;

        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.CommandParameterReferencesEntity);
    }

    // ---- KOI1602: reference other aggregates by Id, not directly -----------

    [Fact]
    public void An_entity_referencing_an_entity_in_another_aggregate_is_reported()
    {
        const string src = """
            context Sales {
              aggregate Orders root Order {
                entity Order identified by OrderId {
                  customer: Customer
                }
              }
              aggregate Customers root Customer {
                entity Customer identified by CustomerId {
                  name: String
                }
              }
            }
            """;

        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.EntityReferencesForeignAggregate);
    }

    [Fact]
    public void An_entity_referencing_another_aggregate_by_id_is_clean()
    {
        const string src = """
            context Sales {
              aggregate Orders root Order {
                entity Order identified by OrderId {
                  customer: CustomerId
                }
              }
              aggregate Customers root Customer {
                entity Customer identified by CustomerId {
                  name: String
                }
              }
            }
            """;

        Diagnose(src).ShouldNotContain(d => d.Code == DiagnosticCodes.EntityReferencesForeignAggregate);
    }

    [Fact]
    public void A_child_entity_within_the_same_aggregate_is_clean()
    {
        const string src = """
            context Sales {
              aggregate Orders root Order {
                entity Order identified by OrderId {
                  lines: List<LineItem>
                }
                entity LineItem identified by LineItemId {
                  quantity: Int
                }
              }
            }
            """;

        Diagnose(src).ShouldNotContain(d => d.Code == DiagnosticCodes.EntityReferencesForeignAggregate);
    }

    [Fact]
    public void An_entity_field_typed_as_an_aggregate_is_reported()
    {
        const string src = """
            context Sales {
              aggregate Orders root Order {
                entity Order identified by OrderId {
                  related: Customers
                }
              }
              aggregate Customers root Customer {
                entity Customer identified by CustomerId {
                  name: String
                }
              }
            }
            """;

        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.EntityReferencesForeignAggregate);
    }

    // ---- recursion into Map value types and optionality --------------------

    [Fact]
    public void A_value_object_map_value_typed_as_an_entity_is_reported()
    {
        // Exercises the `tr.Value` recursion branch (the map's value type), not just `tr.Element`.
        const string src = """
            context Sales {
              entity Order identified by OrderId {
                total: Decimal
              }
              value OrdersByRef {
                byRef: Map<String, Order>
              }
            }
            """;

        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.ValueObjectReferencesEntity);
    }

    [Fact]
    public void An_optional_value_object_field_typed_as_an_entity_is_reported()
    {
        const string src = """
            context Sales {
              entity Order identified by OrderId {
                total: Decimal
              }
              value OrderSummary {
                order: Order?
              }
            }
            """;

        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.ValueObjectReferencesEntity);
    }

    [Fact]
    public void An_entity_map_value_referencing_another_aggregate_is_reported()
    {
        // Exercises the `tr.Value` recursion branch of the cross-aggregate check.
        const string src = """
            context Sales {
              aggregate Orders root Order {
                entity Order identified by OrderId {
                  byCustomer: Map<String, Customer>
                }
              }
              aggregate Customers root Customer {
                entity Customer identified by CustomerId {
                  name: String
                }
              }
            }
            """;

        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.EntityReferencesForeignAggregate);
    }

    // ---- KOI1605: entities hold state, not events/read-models/queries ------

    [Fact]
    public void An_entity_field_typed_as_a_domain_event_is_reported()
    {
        const string src = """
            context Sales {
              event OrderShipped {
                orderId: OrderId
              }
              aggregate Orders root Order {
                entity Order identified by OrderId {
                  total:     Decimal
                  lastEvent: OrderShipped
                }
              }
            }
            """;

        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.EntityFieldReferencesMessageType);
    }

    [Fact]
    public void An_entity_field_typed_as_a_read_model_is_reported()
    {
        const string src = """
            context Sales {
              entity Order identified by OrderId {
                total: Decimal
              }
              readmodel OrderRow from Order {
                id
                total
              }
              entity Desk identified by DeskId {
                row: OrderRow
              }
            }
            """;

        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.EntityFieldReferencesMessageType);
    }

    [Fact]
    public void An_entity_field_typed_as_a_query_is_reported()
    {
        const string src = """
            context Sales {
              entity Order identified by OrderId {
                total: Decimal
              }
              readmodel OrderRow from Order {
                id
                total
              }
              query OrdersByStatus(status: String): List<OrderRow>
              entity Desk identified by DeskId {
                lastQuery: OrdersByStatus
              }
            }
            """;

        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.EntityFieldReferencesMessageType);
    }

    [Fact]
    public void An_entity_collection_of_domain_events_is_reported()
    {
        // Exercises the element recursion: a List<Event> is flagged at the element span.
        const string src = """
            context Sales {
              event OrderShipped {
                orderId: OrderId
              }
              entity Order identified by OrderId {
                history: List<OrderShipped>
              }
            }
            """;

        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.EntityFieldReferencesMessageType);
    }

    [Fact]
    public void An_entity_of_values_enums_ids_and_child_entities_is_clean()
    {
        const string src = """
            context Sales {
              enum Status { Open, Closed }
              value Money {
                amount: Decimal
              }
              aggregate Orders root Order {
                entity Order identified by OrderId {
                  total:      Money
                  status:     Status
                  customerId: CustomerId
                  lines:      List<LineItem>
                }
                entity LineItem identified by LineItemId {
                  quantity: Int
                }
              }
            }
            """;

        Diagnose(src).ShouldNotContain(d => d.Code == DiagnosticCodes.EntityFieldReferencesMessageType);
    }

    // ---- issue #1664: Classify must resolve against the declaring context --

    /// <summary>
    /// Issue #1664: <c>CheckCrossAggregate</c> called the context-blind 1-arg
    /// <c>ModelIndex.Classify(string)</c> overload, instead of the context-aware
    /// <see cref="Koine.Compiler.Ast.ModelIndex.Classify(string?, string)"/> overload the
    /// <c>ExpressionChecker.cs</c> series (#1634/#1641/#1655) already adopted for the same
    /// anti-pattern. R13.2 lets two contexts each legally declare a type with the same simple name —
    /// uniqueness is enforced per-context, not globally — so <c>ModelIndex</c>'s by-name registry is
    /// last-write-wins across the whole model: context B's later-declared <c>event Order</c> won the
    /// context-blind classify for context A's own, genuinely-a-value-object <c>Order</c> field too,
    /// wrongly rejecting a valid model with KOI1605.
    /// </summary>
    [Fact]
    public void An_entity_field_referencing_its_own_contexts_value_object_is_not_confused_with_a_same_named_event_elsewhere()
    {
        const string src = """
            context A {
              value Order {
                total: Decimal
              }
              entity Receipt identified by ReceiptId {
                order: Order
              }
            }

            context B {
              event Order {
                note: String
              }
            }
            """;

        Diagnose(src).ShouldNotContain(d => d.Code == DiagnosticCodes.EntityFieldReferencesMessageType);
    }

    /// <summary>
    /// The inverse of the previous case: guards against the fix hiding a genuine violation. Before
    /// the fix, context B's later-declared <c>value Order</c> would win the context-blind classify,
    /// masking context A's real mistake of holding its own <c>event Order</c> as an entity field.
    /// </summary>
    [Fact]
    public void An_entity_field_referencing_its_own_contexts_event_is_still_reported_despite_a_same_named_value_object_elsewhere()
    {
        const string src = """
            context A {
              event Order {
                note: String
              }
              entity Receipt identified by ReceiptId {
                order: Order
              }
            }

            context B {
              value Order {
                total: Decimal
              }
            }
            """;

        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.EntityFieldReferencesMessageType);
    }

    /// <summary>
    /// Same anti-pattern, the other call site: <c>CheckMemberType</c> (feeds KOI1601/1603/1604) also
    /// called the context-blind overload. Context B's later-declared <c>entity Currency</c> would win
    /// the context-blind classify for context A's own <c>enum Currency</c> value-object member too.
    /// </summary>
    [Fact]
    public void A_value_object_field_referencing_its_own_contexts_enum_is_not_confused_with_a_same_named_entity_elsewhere()
    {
        const string src = """
            context A {
              enum Currency { EUR, USD }
              value Money {
                amount:   Decimal
                currency: Currency
              }
            }

            context B {
              entity Currency identified by CurrencyId {
                name: String
              }
            }
            """;

        Diagnose(src).ShouldNotContain(d => d.Code == DiagnosticCodes.ValueObjectReferencesEntity);
    }

    /// <summary>
    /// The inverse of the previous case: guards against the fix hiding a genuine violation. Before
    /// the fix, context B's later-declared <c>enum Currency</c> would win the context-blind classify,
    /// masking context A's real mistake of composing its value object from its own <c>entity Currency</c>.
    /// </summary>
    [Fact]
    public void A_value_object_field_referencing_its_own_contexts_entity_is_still_reported_despite_a_same_named_enum_elsewhere()
    {
        const string src = """
            context A {
              entity Currency identified by CurrencyId {
                name: String
              }
              value Money {
                amount:   Decimal
                currency: Currency
              }
            }

            context B {
              enum Currency { EUR, USD }
            }
            """;

        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.ValueObjectReferencesEntity);
    }
}
