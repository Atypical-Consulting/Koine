using Koine.Compiler.Diagnostics;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Issue #296 — DDD reference discipline. The semantic validator must reject models in which a
/// building block holds a reference it shouldn't: a value object embedding an entity/aggregate
/// (KOI1601), an entity/aggregate referencing another aggregate directly instead of by Id (KOI1602),
/// a command/factory parameter typed as an entity/aggregate (KOI1603), or a domain-event field typed
/// as an entity/aggregate (KOI1604).
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
}
